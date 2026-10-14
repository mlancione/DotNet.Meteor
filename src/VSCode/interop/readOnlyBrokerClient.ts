import { MultiplexingStream } from 'nerdbank-streams';
import { Duplex } from 'stream';
import { decode, encode } from 'msgpack-lite';
import { AbstractMessageReader, AbstractMessageWriter, createMessageConnection, DataCallback,
    Disposable, Message, MessageConnection, ParameterStructures } from 'vscode-jsonrpc/node';

export interface ServiceBroker {
    getPipe(moniker: { name: string; version: string }): Promise<NodeJS.ReadWriteStream | null>;
}

/** StreamJsonRpc's MessagePack transport uses a four-byte big-endian length prefix. */
export class BrokerMessageReader extends AbstractMessageReader {
    private buffer = Buffer.alloc(0);
    private listening?: Disposable;
    constructor(private readonly stream: NodeJS.ReadWriteStream) { super(); }

    public listen(callback: DataCallback): Disposable {
        const data = (chunk: Buffer) => {
            try {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                while (this.buffer.length >= 4) {
                    const size = this.buffer.readUInt32BE(0);
                    if (size === 0 || size > 16 * 1024 * 1024) {
                        throw new Error('Invalid C# project-system message length.');
                    }
                    if (this.buffer.length < size + 4) {
                        break;
                    }
                    const message = decode(this.buffer.subarray(4, size + 4));
                    this.buffer = this.buffer.subarray(size + 4);
                    callback(message);
                }
            } catch (error) {
                this.fireError(error);
                (this.stream as Duplex).destroy();
            }
        };
        const error = (error: Error) => this.fireError(error);
        const close = () => this.fireClose();
        this.stream.on('data', data).on('error', error).on('end', close).on('close', close);
        this.listening = { dispose: () => {
            this.stream.removeListener('data', data);
            this.stream.removeListener('error', error);
            this.stream.removeListener('end', close);
            this.stream.removeListener('close', close);
            this.buffer = Buffer.alloc(0);
        } };
        return this.listening;
    }
    public dispose(): void {
        this.listening?.dispose();
        this.listening = undefined;
        super.dispose();
    }
}

export class BrokerMessageWriter extends AbstractMessageWriter {
    private readonly pending = new Set<Promise<void>>();
    constructor(private readonly stream: NodeJS.ReadWriteStream) { super(); }
    public write(message: Message): Promise<void> {
        const payload = encode(message);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length);
        const pending = new Promise<void>((resolve, reject) => {
            this.stream.write(Buffer.concat([header, payload]), (error?: Error | null) => {
                if (error) {
                    this.fireError(error, message);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        this.pending.add(pending);
        void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
        return pending;
    }
    public async settled(): Promise<void> { await Promise.allSettled([...this.pending]); }
    public end(): void { this.stream.end(); }
}

/** Consumes the installed Dev Kit's broker; exposes only read and observe operations. */
export class ReadOnlyBrokerClient implements Disposable {
    private disposed = false;
    private constructor(private readonly connection: MessageConnection, private readonly multiplex: MultiplexingStream,
        private readonly writer: BrokerMessageWriter) {}

    public static async open(broker: ServiceBroker, name: string): Promise<ReadOnlyBrokerClient> {
        const pipe = await broker.getPipe({ name, version: '0.1' });
        if (!pipe) {
            throw new Error(`C# Dev Kit service is unavailable: ${name}.`);
        }
        const multiplex = MultiplexingStream.Create(pipe, { protocolMajorVersion: 3, seededChannels: [{}] });
        const channel = multiplex.acceptChannel(0);
        const writer = new BrokerMessageWriter(channel.stream);
        const connection = createMessageConnection(new BrokerMessageReader(channel.stream), writer);
        const client = new ReadOnlyBrokerClient(connection, multiplex, writer);
        channel.completion.catch(() => {}).finally(() => client.dispose());
        multiplex.completion.catch(() => {}).finally(() => client.dispose());
        connection.listen();
        return client;
    }

    public getAll<T>(): Promise<T> {
        return this.connection.sendRequest('getAll', ParameterStructures.byPosition);
    }

    public async observe<T>(next: (value: T) => void, completed: () => void): Promise<Disposable> {
        // The observer is a connection-local marshaled object, retained until unsubscribe.
        const registrations: Disposable[] = [];
        const register = (method: string, callback: (...args: any[]) => void) => {
            registrations.push(this.connection.onRequest(`$/invokeProxy/1/${method}`, callback),
                this.connection.onNotification(`$/invokeProxy/1/${method}`, callback));
        };
        register('onNext', next);
        register('onError', completed);
        register('onCompleted', completed);
        registrations.push(this.connection.onClose(completed));
        registrations.push(this.connection.onDispose(completed));
        try {
            const remote = await this.connection.sendRequest<any>('subscribe', ParameterStructures.byPosition,
                { __jsonrpc_marshaled: 1, handle: 1, lifetime: 'explicit' });
            if (remote?.__jsonrpc_marshaled !== 1 || !Number.isInteger(remote.handle)) {
                throw new Error('C# Dev Kit returned an invalid configuration subscription.');
            }
            let disposed = false;
            return { dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                registrations.forEach(item => item.dispose());
                if (!this.disposed) {
                    void this.connection.sendNotification('$/releaseMarshaledObject', { handle: remote.handle, ownedBySender: false }).catch(() => {});
                }
            } };
        } catch (error) {
            registrations.forEach(item => item.dispose());
            throw error;
        }
    }

    public dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.connection.dispose();
            // Let a queued unsubscribe frame finish before closing its channel.
            void this.writer.settled().then(() => this.multiplex.dispose());
        }
    }
}
