import {IncomingRequest, OutgoingResponse, Server} from "@nestjs/microservices";
import {PubSubEvents} from "./pubsub.events";
import {Logger} from "@nestjs/common";
import {Producer} from "sqs-producer/dist/esm";
import {QueueName, PubSubConsumerMapValues, PubSubOptions} from "./pubsub.interface";
import {Consumer} from "sqs-consumer";
import {Message} from "sqs-producer";
import {NO_MESSAGE_HANDLER} from "@nestjs/microservices/constants";
import {PubSubContext} from "./pubsub.context";
import { Reflector } from '@nestjs/core';
import { EventEmitter as NodeEventEmitter } from 'events';
import { PUBSUB_HANDLER_OPTIONS } from './pubsub.decorator';

export class PubSubServer extends Server<PubSubEvents>{
    protected logger = new Logger(PubSubServer.name)
    private readonly maxRetries = 3; // Number of retry attempts for sending messages
    private readonly retryDelay = 1000; // Delay between retry attempts in milliseconds
    private client: Producer;
    private replyQueueName?: string;
    public readonly consumers = new Map<QueueName, PubSubConsumerMapValues>();
    public readonly producers = new Map<QueueName, Producer>();
    protected pendingEventListeners: Array<{
        name: string;
        event: keyof PubSubEvents;
        callback: PubSubEvents[keyof PubSubEvents];
    }> = [];
    private reflector = new Reflector();
    private eventEmitter = new NodeEventEmitter();

    constructor(protected options : PubSubOptions) {
        super();
        // Provide sensible defaults
        this.options.logger = this.options.logger || new Logger('PubSubServer');
        // Use default JSON serializer/deserializer
        this.options.serializer = this.options.serializer || {
            serialize: (value: any) => value,
        };
        this.options.deserializer = this.options.deserializer || {
            deserialize: (value: any) => value,
        };
        // Validate required options
        if (!this.options.consumers && !this.options.consumer) {
            throw new Error('At least one consumer configuration is required.');
        }
        this.initializeSerializer(this.options);
        this.initializeDeserializer(this.options);
    }

    // Helper to get handler options from metadata
    private getHandlerOptions(handler: Function) {
        return this.reflector.get(PUBSUB_HANDLER_OPTIONS, handler) || {};
    }

    async listen(callback: () => void): Promise<any> {
        for (const options of this.options.consumers) {
            // Add support for scopedEnvKey to prefix queue names
            const prefix = this.options.scopedEnvKey ? `${this.options.scopedEnvKey}_` : '';
            const name = `${prefix}${options.name}`;
            const { name: _origName, ...option } = options;
            if (!this.consumers.has(name)) {
                try {
                    // Remove queueName property, use correct SQS property (e.g., queueUrl)
                    const consumer = Consumer.create({
                        ...option,
                        // queueUrl: name, // Uncomment and use if your PubSubConsumerOptions expects queueUrl
                    });
                    // Attach any pending event listeners for this consumer
                    const pending = this.pendingEventListeners.filter((f) => f.name === name);
                    for (const emitter of pending) {
                        if (emitter) {
                            consumer.on(emitter.event as any, emitter.callback as any);
                        }
                    }
                    // Remove attached listeners from pendingEventListeners
                    this.pendingEventListeners = this.pendingEventListeners.filter((f) => f.name !== name);

                    consumer.on('message_received', async (message, metadata) => {
                        try {
                            // Pass the raw SQS message to the context for ack/nack support
                            await this.handleMessage(message);
                        } catch (error) {
                            this.logger.error('Error handling message:', error);
                        }
                    }).on('error', (err) => {
                        this.logger.error(err);
                    });

                    // Start the consumer
                    consumer.start();
                    // Store the consumer in the map for later management
                    this.consumers.set(name, { instance: consumer, stopOptions: options.stopOptions });
                } catch (err) {
                    this.logger.error(`Failed to create/start consumer for queue '${name}':`, err);
                }
            }
        }
        callback();
    }

    async close(): Promise<void> {
        await Promise.all(
            Array.from(this.consumers.values()).map(({instance}) => instance.stop())
        )
    }

    // Emit an event
    public emit<EventKey extends keyof PubSubEvents>(event: EventKey, ...args: Parameters<PubSubEvents[EventKey]>) {
        this.eventEmitter.emit(event, ...args);
    }

    // Subscribe to an event
    public on<EventKey extends keyof PubSubEvents>(event: EventKey, listener: PubSubEvents[EventKey]) {
        this.eventEmitter.on(event, listener);
    }

    async handleMessage(message: any) {
        const { body, messageAttributes } = message;
        let rawMessage;
        try {
            rawMessage = JSON.parse(body.toString());
        } catch (error: any) {
            this.logger.error(
                `Unsupported JSON message data format for message '${message.MessageId || message.id}'`,
            );
            this.emit('error' as any, error);
            return;
        }

        // SNS-to-SQS fan-out support: unwrap SNS envelope if present
        if (rawMessage.Type === 'Notification' && rawMessage.Message) {
            try {
                rawMessage = JSON.parse(rawMessage.Message);
            } catch (error: any) {
                this.logger.error('Failed to parse SNS Message property as JSON');
                this.emit('error' as any, error);
                return;
            }
        }

        // Prefer pattern from message attributes (NestJS), fallback to body (Laravel/other)
        let pattern: string | undefined;
        if (messageAttributes && messageAttributes.pattern && messageAttributes.pattern.StringValue) {
            pattern = messageAttributes.pattern.StringValue;
        } else if (rawMessage.pattern) {
            pattern = rawMessage.pattern;
        }

        // If pattern is missing, log and skip
        if (!pattern) {
            this.logger.error('No pattern found in message attributes or body.');
            this.emit('error' as any, 'No pattern found in message attributes or body.');
            return;
        }

        // Prefer id from message attributes, fallback to body
        const id = (messageAttributes && messageAttributes.id && messageAttributes.id.StringValue) || rawMessage.id;

        // Use the deserializer for the packet
        const packet = this.deserializer.deserialize({
            data: rawMessage,
            pattern,
            id,
        }) as IncomingRequest;

        const context = new PubSubContext([message, pattern]);
        const correlationId = packet.id;
        const handler = this.getHandlerByPattern(pattern);
        if (!handler) {
            const status = 'error';
            const noHandlerPacket = {
                id: correlationId,
                status,
                err: NO_MESSAGE_HANDLER,
            };
            this.emit('processing_error' as any);
            this.emit('error' as any, NO_MESSAGE_HANDLER);
            return this.sendMessage(noHandlerPacket, messageAttributes?.id?.StringValue, correlationId);
        }

        // Emit message_received event
        this.emit('message_received' as any, message);

        // Restore handler options logic for batch/custom decorators
        const handlerOptions = this.reflector.get(PUBSUB_HANDLER_OPTIONS, handler) || {};
        if (handlerOptions.batch) {
            const batch = [{ data: packet.data, context }];
            try {
                await handler(batch);
                this.emit('batch_processed' as any, batch);
            } catch (err) {
                this.emit('processing_error' as any);
                this.emit('error' as any, err);
            }
        } else {
            try {
                const handlerResult = await handler(packet.data, context);
                if (handlerResult === true) await context.ack();
                else if (handlerResult === false) await context.nack();
                this.emit('message_processed' as any, message);
            } catch (err) {
                this.emit('processing_error' as any);
                this.emit('error' as any, err);
            }
        }

        const response$ = this.transformToObservable(undefined); // No response for batch by default
        const publish = <T>(data: T) => this.sendMessage(data, messageAttributes?.id?.StringValue, correlationId);
        response$ && this.send(response$, publish);
    }

    async sendMessage<T = any>( message: T, replyTo: string, id: string) {
        Object.assign(message, {id})
        const outGoingResponse = this.serializer.serialize(message as unknown as OutgoingResponse)
        this.logger.log(outGoingResponse)
    }

    // Add unwrap method to satisfy abstract member from Server
    public unwrap<T = any>(): T {
        // Return the consumers map as the main managed resource
        return this.consumers as unknown as T;
    }
} 