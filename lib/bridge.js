'use strict';

const { DEVICES, stateCommon, t } = require('./fields');
const { createSources } = require('./profiles');
const { Analysis, TODAY_KEYS, analysisOptions, analysisStates } = require('./analysis');

/** How often the bridge checks whether the data of a device is stale. */
const STALE_CHECK_MS = 5_000;

/** Data points renamed before the first public release: old ID → new ID. */
const RENAMED_STATES = {
    'analysis.cost_now_eur_h': 'analysis.cost_now_per_h',
    'analysis.savings_now_eur_h': 'analysis.savings_now_per_h',
    'analysis.grid_balance_eur_h': 'analysis.grid_balance_per_h',
    'analysis.today.cost_eur': 'analysis.today.cost',
    'analysis.today.savings_eur': 'analysis.today.savings',
};

/**
 * @param {object} source
 * @returns {boolean} true if the source is polled, false if it reads from the MQTT broker
 */
function isPolled(source) {
    return typeof source.poll === 'function';
}

/**
 * Connects the data sources (MQTT topics or polled devices) with ioBroker data points.
 *
 * The class only uses the few adapter methods it needs, so it can be tested without js-controller.
 */
class Bridge {
    /**
     * @param {object} adapter ioBroker adapter (namespace, log, setStateAsync, setStateChangedAsync, getStateAsync,
     *   getObjectAsync, delObjectAsync, extendObjectAsync, setObjectNotExistsAsync, setInterval, clearInterval,
     *   setTimeout, clearTimeout)
     * @param {object} config adapter configuration (native), plus `language` of the system
     * @param {(url: string, options: object) => import('mqtt').MqttClient} connect mqtt.connect
     * @param {{sources?: any[], mtecQuietMs?: number, now?: number}} [options] tests: `sources` instead of the ones
     *   from the configuration, the others see createSources
     */
    constructor(adapter, config, connect, options = {}) {
        this.adapter = adapter;
        this.config = config;
        this.connect = connect;
        this.client = null;
        this.timer = null;
        this.sources = options.sources || createSources(config, options);
        this.mqttSources = this.sources.filter(s => !isPolled(s));
        this.pollSources = this.sources.filter(isPolled);
        this.stale = new Map();
        this.flushTimers = new Map();
        this.pollTimers = new Map();
        this.loggedOnce = new Set();
        this.createdObjects = new Set();
        this.mqttConnected = false;
        /** Polled source → result of its last poll (true = device reachable). */
        this.pollOk = new Map();
        /** Last written value of each connection state. */
        this.connection = new Map();
        this.stopped = false;
        /** All processing runs one after another, in the order of arrival. */
        this.queue = Promise.resolve();
        /** Analysis (house consumption, battery forecast, cost, daily values) – needs the Energy Butler. */
        this.analysis = this.sources.some(s => s.device === 'butler') ? new Analysis(analysisOptions(config)) : null;
    }

    async start() {
        await this.createObjects();
        await this.migrateRenamedStates();
        await this.restoreAnalysis();
        await this.checkStale();
        await this.updateConnection();
        this.timer = this.adapter.setInterval(
            () => this.enqueue(() => this.checkStale()).catch(e => this.adapter.log.warn(`Stale check: ${e.message}`)),
            STALE_CHECK_MS,
        );
        if (this.mqttSources.length) {
            this.connectMqtt();
        }
        for (const source of this.pollSources) {
            this.schedulePoll(source, 0);
        }
    }

    connectMqtt() {
        const { host, port, username, password } = this.config;
        const url = `mqtt://${host}:${Number(port) || 1883}`;
        const client = this.connect(url, {
            username: username || undefined,
            password: password || undefined,
            clientId: `iobroker_${this.adapter.namespace.replace('.', '_')}_${Math.random().toString(16).slice(2, 8)}`,
            clean: true,
            reconnectPeriod: 5_000,
            connectTimeout: 10_000,
        });
        this.client = client;

        client.on('connect', () => {
            this.adapter.log.info(`Connected to ${url}`);
            this.setConnected(true);
            const subscriptions = Object.fromEntries(
                this.mqttSources.flatMap(s => s.subscriptions).map(s => [s.topic, { qos: s.qos }]),
            );
            client.subscribe(subscriptions, (err, granted) => {
                if (err) {
                    this.adapter.log.error(`Subscribing failed: ${err.message}`);
                    return;
                }
                for (const g of granted || []) {
                    if (g.qos === 128) {
                        this.adapter.log.error(`The broker refused the subscription of ${g.topic}`);
                    }
                }
            });
        });
        client.on('close', () => this.setConnected(false));
        client.on('error', err => this.adapter.log.warn(`MQTT: ${err.message}`));
        client.on('message', (topic, payload) => {
            const now = Date.now();
            this.enqueue(() => this.handleMessage(topic, payload, now)).catch(e =>
                this.adapter.log.warn(`Processing ${topic}: ${e.message}`),
            );
        });
    }

    async stop() {
        this.stopped = true;
        if (this.timer) {
            this.adapter.clearInterval(this.timer);
            this.timer = null;
        }
        for (const timer of [...this.flushTimers.values(), ...this.pollTimers.values()]) {
            this.adapter.clearTimeout(timer);
        }
        this.flushTimers.clear();
        this.pollTimers.clear();
        if (this.client) {
            await this.client.endAsync(true).catch(() => {});
            this.client = null;
        }
        for (const source of this.pollSources) {
            await Promise.resolve(source.close?.()).catch(() => {});
        }
        this.mqttConnected = false;
        this.pollOk.clear();
        await this.updateConnection().catch(() => {});
    }

    /**
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    enqueue(fn) {
        const run = this.queue.then(fn);
        this.queue = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    setConnected(connected) {
        this.mqttConnected = connected;
        this.updateConnection().catch(() => {});
    }

    /** Writes `<device>.info.connection` and `info.connection` (true if all configured connections are up). */
    async updateConnection() {
        /** @type {Record<string, boolean>} */
        const states = {};
        for (const source of this.sources) {
            states[`${source.device}.info.connection`] = isPolled(source)
                ? this.pollOk.get(source) === true
                : this.mqttConnected;
        }
        const all = Object.values(states);
        states['info.connection'] = all.length > 0 && all.every(Boolean);
        for (const [id, val] of Object.entries(states)) {
            if (this.connection.get(id) !== val) {
                this.connection.set(id, val);
                await this.adapter.setStateAsync(id, val, true);
            }
        }
    }

    /**
     * @param {any} source polled source
     * @param {number} delayMs
     */
    schedulePoll(source, delayMs) {
        this.pollTimers.set(
            source,
            this.adapter.setTimeout(() => {
                this.pollTimers.delete(source);
                this.runPoll(source).catch(e => this.adapter.log.warn(`Processing ${source.profile}: ${e.message}`));
            }, delayMs),
        );
    }

    /**
     * Reads a polled source once, processes the results and schedules the next poll. The reading itself runs
     * outside the queue, so a slow device does not hold up the MQTT messages.
     *
     * @param {any} source polled source
     */
    async runPoll(source) {
        const start = Date.now();
        let results = [];
        let ok = true;
        try {
            results = await source.poll(start);
        } catch (e) {
            ok = false;
            const before = this.pollOk.get(source);
            this.adapter.log[before === false ? 'debug' : 'warn'](
                `${source.device}: reading via ${source.profile} failed (${e.message})`,
            );
        }
        if (this.stopped) {
            return;
        }
        if (ok && this.pollOk.get(source) === false) {
            this.adapter.log.info(`${source.device}: reading via ${source.profile} works again`);
        }
        this.pollOk.set(source, ok);
        const now = Date.now();
        try {
            await this.enqueue(async () => {
                for (const result of results) {
                    await this.apply(source, result, source.profile, now);
                }
                await this.updateConnection();
            });
        } finally {
            if (!this.stopped) {
                this.schedulePoll(source, Math.max(0, start + source.intervalMs - Date.now()));
            }
        }
    }

    async createObjects() {
        for (const source of this.sources) {
            const id = source.device;
            const device = DEVICES[id];
            const staleSeconds = source.staleMs / 1000;
            await this.adapter.extendObjectAsync(id, { type: 'channel', common: { name: device.name }, native: {} });
            await this.adapter.extendObjectAsync(`${id}.info`, {
                type: 'channel',
                common: { name: 'Information' },
                native: {},
            });
            await this.adapter.extendObjectAsync(`${id}.info.connection`, {
                type: 'state',
                common: {
                    name: t('Connected to the data source', 'Verbunden mit der Datenquelle'),
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            await this.adapter.extendObjectAsync(`${id}.info.lastMeasurement`, {
                type: 'state',
                common: {
                    name: t('Time of the last measurement', 'Zeitpunkt der letzten Messung'),
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.adapter.extendObjectAsync(`${id}.info.stale`, {
                type: 'state',
                common: {
                    name: t('Data older than %s s', 'Daten älter als %s s', staleSeconds),
                    type: 'boolean',
                    role: 'indicator.maintenance',
                    read: true,
                    write: false,
                    def: true,
                },
                native: {},
            });
            if (source.profile === 'mtecmqtt') {
                await this.adapter.extendObjectAsync(`${id}.info.serial`, {
                    type: 'state',
                    common: {
                        name: t('Serial number', 'Seriennummer'),
                        type: 'string',
                        role: 'info.serial',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                if ('serial' in source && source.serial) {
                    await this.adapter.setStateAsync(`${id}.info.serial`, source.serial, true);
                }
            }
            for (const [field, def] of Object.entries(device.fields)) {
                await this.adapter.extendObjectAsync(`${id}.${field}`, {
                    type: 'state',
                    common: stateCommon(field, def),
                    native: {},
                });
            }
        }
        if (this.analysis) {
            await this.adapter.extendObjectAsync('analysis', {
                type: 'channel',
                common: { name: t('Analysis', 'Auswertung') },
                native: {},
            });
            await this.adapter.extendObjectAsync('analysis.today', {
                type: 'channel',
                common: { name: t('Daily values (since midnight)', 'Tageswerte (seit Mitternacht)') },
                native: {},
            });
            for (const [key, common] of Object.entries(analysisStates(this.analysis.o.currency))) {
                await this.adapter.extendObjectAsync(`analysis.${key}`, {
                    type: 'state',
                    common: { ...common, read: true, write: false },
                    native: {},
                });
            }
        }
    }

    /** Renamed data points: takes over today's values and deletes the old objects. */
    async migrateRenamedStates() {
        for (const [oldId, newId] of Object.entries(RENAMED_STATES)) {
            const obj = await this.adapter.getObjectAsync(oldId);
            if (!obj) {
                continue;
            }
            if (this.analysis && oldId.startsWith('analysis.today.')) {
                const old = await this.adapter.getStateAsync(oldId);
                const current = await this.adapter.getStateAsync(newId);
                if (
                    old &&
                    old.val !== null &&
                    old.val !== undefined &&
                    (!current || current.val === null || current.val === undefined)
                ) {
                    await this.adapter.setStateAsync(newId, { val: old.val, ack: true, ts: old.ts });
                }
            }
            await this.adapter.delObjectAsync(oldId);
            this.adapter.log.info(`Data point ${oldId} was renamed to ${newId}`);
        }
    }

    /** Takes over the daily values after a restart if they are from the same day. */
    async restoreAnalysis() {
        if (!this.analysis) {
            return;
        }
        const read = async id => {
            const st = await this.adapter.getStateAsync(id);
            return st ? st.val : null;
        };
        const day = await read('analysis.today.date');
        /** @type {Record<string, any>} */
        const values = {};
        for (const k of TODAY_KEYS) {
            values[k] = await read(`analysis.today.${k}`);
        }
        if (this.analysis.restore(day, values, Date.now())) {
            this.adapter.log.info(`Daily values of ${day} restored`);
        }
    }

    async writeAnalysis(values, ts) {
        await Promise.all(
            Object.entries(values).map(([key, val]) =>
                this.adapter.setStateChangedAsync(`analysis.${key}`, { val, ack: true, ts }),
            ),
        );
    }

    /**
     * Logs a message only the first time at the given level, later only as debug.
     *
     * @param key
     * @param level
     * @param message
     */
    logOnce(key, level, message) {
        const first = !this.loggedOnce.has(key);
        this.loggedOnce.add(key);
        this.adapter.log[first ? level : 'debug'](message);
    }

    async handleMessage(topic, payload, now) {
        const source = this.mqttSources.find(s => s.matches(topic));
        if (!source) {
            return;
        }
        for (const result of source.handle(topic, payload, now)) {
            await this.apply(source, result, topic, now);
        }
        if (source.pending) {
            this.armFlush(source);
        }
    }

    /**
     * Processes the collected values of a source once its topics have been quiet for a moment.
     *
     * @param source
     */
    armFlush(source) {
        const pending = this.flushTimers.get(source);
        if (pending) {
            this.adapter.clearTimeout(pending);
        }
        this.flushTimers.set(
            source,
            this.adapter.setTimeout(() => {
                this.flushTimers.delete(source);
                this.enqueue(() => this.flushSource(source, Date.now())).catch(e =>
                    this.adapter.log.warn(`Processing ${source.profile}: ${e.message}`),
                );
            }, source.quietMs),
        );
    }

    async flushSource(source, now) {
        for (const result of source.flush(now)) {
            await this.apply(source, result, source.profile, now);
        }
    }

    async apply(source, result, topic, now) {
        const id = source.device;
        switch (result.type) {
            case 'invalid':
                this.logOnce(
                    `${id}:invalid:${result.reason}`,
                    'warn',
                    `${topic}: message discarded (${result.reason})`,
                );
                return;
            case 'skipped':
                this.adapter.log.debug(`${topic}: ${result.reason}, discarded`);
                return;
            case 'foreign':
                this.logOnce(
                    `${id}:foreign:${result.serial}`,
                    'warn',
                    `${topic}: ignored, this instance reads serial number ${source.serial}. Use one instance per device.`,
                );
                return;
            case 'serial':
                this.adapter.log.info(`MTECmqtt: reading the Energy Butler with serial number ${result.serial}`);
                await this.adapter.setStateAsync(`${id}.info.serial`, result.serial, true);
                return;
            case 'expired':
                this.adapter.log.info(
                    `MTECmqtt: no values of ${result.groups.join(', ')} for ${source.slowStaleMs / 1000} s, its data points are set to null`,
                );
                await Promise.all(
                    result.updates.map(u =>
                        this.adapter.setStateAsync(`${id}.${u.field}`, {
                            val: u.val,
                            ack: true,
                            ts: result.ts,
                            q: u.q,
                        }),
                    ),
                );
                return;
            case 'record':
                await this.applyRecord(source, result, topic, now);
                return;
        }
    }

    async applyRecord(source, rec, topic, now) {
        const id = rec.device;
        for (const field of rec.unknown) {
            if (!this.loggedOnce.has(`${id}.${field}`)) {
                this.loggedOnce.add(`${id}.${field}`);
                this.adapter.log.info(`${topic}: new field "${field}", created as ${id}.${field}`);
                await this.adapter.setObjectNotExistsAsync(`${id}.${field}`, {
                    type: 'state',
                    common: stateCommon(field),
                    native: {},
                });
            }
        }
        for (const field of rec.rejected) {
            this.adapter.log.debug(`${topic}: field "${field}" is not a number and is ignored`);
        }
        for (const field of rec.ignored || []) {
            this.logOnce(
                `${id}:ignored:${field}`,
                'warn',
                `${topic}: field "${field}" ignored, names of new fields may only contain a-z, 0-9 and _, start with a letter and must not be "info" or "mtecmqtt"`,
            );
        }
        for (const group of rec.restored || []) {
            this.adapter.log.info(`MTECmqtt: values of ${group} are coming in again`);
        }
        await this.createExtras(rec.extras);

        const ts = rec.ts;
        await Promise.all(
            rec.updates.map(u => this.adapter.setStateAsync(`${id}.${u.field}`, { val: u.val, ack: true, ts, q: u.q })),
        );
        await Promise.all((rec.extras || []).map(e => this.adapter.setStateAsync(e.id, { val: e.val, ack: true, ts })));
        if (rec.main) {
            await this.adapter.setStateAsync(`${id}.info.lastMeasurement`, { val: ts, ack: true, ts });
            await this.updateStale(source, now);
        }

        if (this.analysis) {
            if (id === 'butler' && rec.main) {
                const r = this.analysis.butler(Object.fromEntries(rec.updates.map(u => [u.field, u.val])), ts);
                await this.writeAnalysis({ ...r.now, ...r.today }, ts);
            } else if (id === 'heatpump') {
                await this.writeAnalysis(
                    this.analysis.heatpump(Object.fromEntries(rec.updates.map(u => [u.field, u.val])), ts),
                    ts,
                );
            }
            if (id === 'butler' && rec.counters) {
                await this.writeAnalysis(this.analysis.counters(rec.counters, ts), ts);
            }
        }
    }

    /**
     * Creates the objects for values without a counterpart (profile mtecmqtt) on first sight.
     *
     * @param extras
     */
    async createExtras(extras) {
        for (const e of extras || []) {
            if (this.createdObjects.has(e.id)) {
                continue;
            }
            for (const ch of e.channels) {
                if (!this.createdObjects.has(ch.id)) {
                    this.createdObjects.add(ch.id);
                    await this.adapter.extendObjectAsync(ch.id, {
                        type: 'channel',
                        common: { name: ch.name },
                        native: {},
                    });
                }
            }
            this.createdObjects.add(e.id);
            await this.adapter.extendObjectAsync(e.id, { type: 'state', common: e.common, native: {} });
            this.adapter.log.debug(`Created ${e.id}`);
        }
    }

    async checkStale() {
        const now = Date.now();
        for (const source of this.sources) {
            for (const result of source.expire(now)) {
                await this.apply(source, result, source.profile, now);
            }
            await this.updateStale(source, now);
        }
    }

    async updateStale(source, now) {
        const stale = source.isStale(now);
        if (stale !== this.stale.get(source)) {
            this.stale.set(source, stale);
            await this.adapter.setStateAsync(`${source.device}.info.stale`, stale, true);
            if (stale && source.lastTs !== null) {
                this.adapter.log.warn(
                    `${source.device}: no current data (last measurement ${new Date(source.lastTs).toISOString()})`,
                );
            }
        }
    }
}

module.exports = { Bridge, RENAMED_STATES };
