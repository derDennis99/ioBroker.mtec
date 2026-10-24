const path = require('path');
const net = require('net');
const { once } = require('events');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

/**
 * Reads a state from the test controller.
 *
 * @param {any} harness test harness
 * @param {string} id full state ID
 */
function getState(harness, id) {
    return new Promise((resolve, reject) =>
        harness.states.getState(id, (err, state) => (err ? reject(err) : resolve(state))),
    );
}

/**
 * Polls until the check returns true.
 *
 * @param {() => Promise<boolean>} check condition
 * @param {number} ms timeout
 */
async function waitFor(check, ms = 20_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('with a local MQTT broker (profile json)', getHarness => {
            let broker;
            let server;
            let port;

            before(async () => {
                const { Aedes } = await import('aedes');
                broker = await Aedes.createBroker();
                broker.authenticate = (client, username, password, cb) => {
                    const ok = username === 'reader' && String(password) === 'secret';
                    cb(ok ? null : Object.assign(new Error('auth'), { returnCode: 4 }), ok);
                };
                server = net.createServer(broker.handle);
                server.listen(0, '127.0.0.1');
                await once(server, 'listening');
                port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
            });

            after(async () => {
                await new Promise(resolve => broker.close(resolve));
                server.close();
            });

            it('connects with user and password and writes values and analysis', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                // retained, so the adapter gets it right after subscribing
                const body = {
                    name: 'butler',
                    fields: {
                        battery_soc_percent: 81,
                        pv_total_power_w: 3000,
                        grid_import_power_w: 1000,
                        grid_export_power_w: 0,
                        battery_charge_power_w: 500,
                        battery_discharge_power_w: 0,
                    },
                    timestamp: Date.now(),
                };
                await new Promise(
                    /** @param {(value?: void) => void} resolve */ (resolve, reject) =>
                        broker.publish(
                            {
                                topic: 'energy/butler/telemetry',
                                payload: Buffer.from(JSON.stringify(body)),
                                qos: 1,
                                retain: true,
                                cmd: 'publish',
                                dup: false,
                            },
                            e => (e ? reject(e) : resolve()),
                        ),
                );

                await harness.changeAdapterConfig('mtec', {
                    native: {
                        host: '127.0.0.1',
                        port,
                        username: 'reader',
                        password: 'secret',
                        profile: 'json',
                        priceImportCt: 30,
                    },
                });
                await harness.startAdapterAndWait(true);

                await waitFor(async () => (await getState(harness, 'mtec.0.analysis.house_power_w'))?.val === 3500);
                expect((await getState(harness, 'mtec.0.info.connection')).val).to.equal(true);
                const soc = await getState(harness, 'mtec.0.butler.battery_soc_percent');
                expect(soc.val).to.equal(81);
                expect(soc.ts).to.equal(body.timestamp);
                expect((await getState(harness, 'mtec.0.butler.pv1_power_w')).val).to.equal(null);
                expect((await getState(harness, 'mtec.0.butler.info.stale')).val).to.equal(false);
                expect((await getState(harness, 'mtec.0.analysis.cost_now_per_h')).val).to.equal(0.3);
            });
        });
    },
});
