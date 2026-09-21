import { EventEmitter } from 'node:events';
import { AIRPLAY_SERVICE, AppleTV, type PairingSession } from '@basmilius/apple-sdk';
import { convertDiscoveryResult, extractMacAddress, waitFor } from '../utils';
import type Homey from 'homey';

const DISCOVERY_TRIES = 10;
const MODEL_FILTER = /AppleTV\d+,\d+/;

type Device = Homey.DiscoveryResultMDNSSD & {
    store?: Record<string, unknown>;
};

export default class AppleTVPairing extends EventEmitter {
    readonly #knownDevices: Homey.Device[];
    readonly #loggedSkips = new Set<string>();
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: Homey.DiscoveryStrategy;
    readonly #devices: Homey.DiscoveryResultMDNSSD[];
    readonly #onDiscoveryResult: (result: Homey.DiscoveryResultMDNSSD) => void;
    #device: Device | undefined;
    #error: string | undefined;
    #pairingSession?: PairingSession;

    constructor(session: Homey.Driver.PairSession, strategy: Homey.DiscoveryStrategy, knownDevices: Homey.Device[]) {
        super();

        this.#knownDevices = knownDevices;
        this.#session = session;
        this.#strategy = strategy;

        this.#devices = Object.values(this.#strategy.getDiscoveryResults()) as Homey.DiscoveryResultMDNSSD[];
        this.#onDiscoveryResult = result => this.#addDevice(result);
        this.#strategy.on('result', this.#onDiscoveryResult);
    }

    async start(): Promise<void> {
        this.#session.setHandler('showView', async view => await this.onShowView(view));

        this.#session.setHandler('list_devices', async () => {
            const devices = this.#selectableDevices();
            this.emit('log', `Discovery: ${this.#devices.length} result(s) on the network, ${devices.length} selectable Apple TV(s).`);
            return devices;
        });

        this.#session.setHandler('list_devices_selection', async (devices: Homey.DiscoveryResultMDNSSD[]) => this.#device = devices.pop());

        this.#session.setHandler('pincode', async (code: Buffer) => await this.onPincode(code));

        this.#session.setHandler('get_pair_error', async () => this.#error ?? null);

        this.#session.setHandler('get_device', async () => {
            this.#strategy.off('result', this.#onDiscoveryResult);
            return {
                name: this.#device?.name,
                data: {
                    id: this.#device?.id
                },
                store: {
                    id: this.#device?.id,
                    credentials: this.#device?.store?.credentials,
                    mac: extractMacAddress(this.#device?.txt as Record<string, string>)
                }
            };
        });
    }

    async onPincode(code: Buffer): Promise<boolean> {
        if (!this.#device || !this.#pairingSession) {
            await this.#fail(new Error('No device selected.'));
            return false;
        }

        const pin = code.join('');
        this.emit('log', `Pairing to ${this.#device.name} with PIN ${pin}`);

        try {
            await this.#pairingSession.pin(pin);
            const credentials = await this.#pairingSession.end();

            this.#device.store ??= {};
            this.#device.store.credentials = {
                accessoryIdentifier: credentials.accessoryIdentifier,
                accessoryLongTermPublicKey: credentials.accessoryLongTermPublicKey.toString('hex'),
                pairingId: credentials.pairingId.toString('hex'),
                publicKey: credentials.publicKey.toString('hex'),
                secretKey: credentials.secretKey.toString('hex')
            };
        } catch (err) {
            this.emit('error', err);
            return false;
        }

        try {
            await this.#session.showView('add_my_device');
        } catch (err) {
            await this.#fail(err);
            return false;
        }

        return true;
    }

    async onShowView(view: string): Promise<void> {
        try {
            switch (view) {
                case 'authenticate':
                    return await this.onShowViewAuthenticate();

                case 'discover':
                    return await this.onShowViewDiscover();
            }
        } catch (err) {
            await this.#fail(err);
        }
    }

    async onShowViewAuthenticate(): Promise<void> {
        if (!this.#device) {
            await this.#session.showView('list_devices');
            this.emit('error', 'No device selected.');
            return;
        }

        const tv = new AppleTV({airplay: convertDiscoveryResult(this.#device, AIRPLAY_SERVICE)});
        this.#pairingSession = tv.createPairingSession();

        this.emit('log', `Connecting to ${this.#device.address}:${this.#device.port}...`);

        try {
            await this.#pairingSession.start();
        } catch (err) {
            this.#pairingSession.abort();
            this.#pairingSession = undefined;
            throw err;
        }
    }

    async onShowViewDiscover(): Promise<void> {
        let tries = DISCOVERY_TRIES;

        while (tries-- > 0) {
            if (this.#selectableDevices().length > 0 || tries === 0) {
                await this.#session.showView('list_devices');
                return;
            }

            await waitFor(1000);
        }
    }

    async #fail(err: unknown): Promise<void> {
        this.#error = err instanceof Error ? err.message : String(err);
        this.emit('error', err);

        try {
            await this.#session.showView('connection_error');
        } catch (viewError) {
            this.emit('error', viewError);
        }
    }

    #addDevice(device: Homey.DiscoveryResultMDNSSD): void {
        if (this.#devices.some(known => known.id === device.id)) {
            return;
        }

        this.#devices.push(device);
    }

    #matchesModel(device: Homey.DiscoveryResultMDNSSD): boolean {
        const model = (device.txt as any)?.model;

        if (!model) {
            if (!this.#loggedSkips.has(device.id)) {
                this.#loggedSkips.add(device.id);
                this.emit('log', `Skipping incomplete discovery result for '${device.name ?? device.id}': missing txt.model`, device);
            }

            return false;
        }

        if (!MODEL_FILTER.test(model)) {
            if (!this.#loggedSkips.has(device.id)) {
                this.#loggedSkips.add(device.id);
                this.emit('log', `Skipping '${device.name ?? device.id}': model '${model}' is not an Apple TV.`);
            }

            return false;
        }

        return true;
    }

    #selectableDevices(): Homey.DiscoveryResultMDNSSD[] {
        return this.#devices
            .filter(device => !this.#knownDevices.some(knownDevice => knownDevice.getData().id === device.id))
            .filter(device => this.#matchesModel(device))
            .toSorted((a, b) => a.name.localeCompare(b.name));
    }
}
