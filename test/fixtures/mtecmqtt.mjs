// MTECmqtt output as published by version 2.1.0: one topic per value, plain text,
// floats as "{:.3f}", integers plainly, a scaled 0 as "0". The serial number is made up.

export const SERIAL = 'SN0000000001';

/** Values of one MTECmqtt loop per group, as MTECmqtt publishes them. */
export const ROUNDS = {
    'now-base': {
        api_date: '2026-10-17 12:00:00',
        inverter_date: '26-10-17 12:00:00',
        inverter_status: '2',
        grid_power: '-628',
        inverter: '1450',
        pv: '2300',
        backup: '0',
        battery_voltage: '51.200',
        battery_current: '-12.300',
        battery_mode: '1',
        battery: '-1036',
        battery_soc: '38.400',
        mode: '257',
        consumption: '2078',
    },
    'now-grid': {
        grid_a: '-210',
        grid_b: '-200',
        grid_c: '-218',
        ac_voltage_a: '230.500',
        ac_current_a: '6.300',
        grid_fequency: '50.010',
    },
    'now-pv': {
        pv_generation_duration: '1234',
        pv_voltage_1: '350.200',
        pv_current_1: '3.300',
        pv_1: '1150',
        pv_2: '1150',
    },
    day: {
        grid_feed_day: '0',
        grid_purchase_day: '4.300',
        backup_day: '0',
        battery_charge_day: '2.100',
        battery_discharge_day: '1.500',
        pv_day: '6.700',
        consumption_day: '10.400',
        autarky_rate_day: '58.654',
        own_consumption_day: '100.000',
    },
    config: {
        serial_no: SERIAL,
        firmware_version: '27.52.4.0',
    },
};
