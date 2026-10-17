'use strict';

/**
 * Field definitions of the adapter's own data points (`heatpump.*`, `butler.*`).
 *
 * The field names are those of the `json` input profile (see docs/profile-json.md).
 * Other profiles map their values onto these names.
 * `bool: true` converts 0/1 to false/true.
 */

/**
 * Multilingual name for `common.name`.
 *
 * @param {string} en
 * @param {string} de
 */
const t = (en, de) => ({ en, de });

const SENSOR_STATES = { 0: 'OK' };

const HEATPUMP_OPERATING_STATES = {
    0: 'Standby',
    1: 'Pre-run',
    2: 'Heating',
    3: 'Defrosting',
    4: 'Cooling',
    5: 'Post-run',
    7: 'Safety shutdown',
    8: 'Error',
};

const INVERTER_STATES = {
    0: 'Waiting',
    1: 'Self-check',
    2: 'On-grid',
    3: 'Fault',
    4: 'Firmware update',
    5: 'Off-grid',
};

const temp = name => ({ name, role: 'value.temperature', unit: '°C' });
const power = name => ({ name, role: 'value.power', unit: 'W' });
const percent = name => ({ name, role: 'value', unit: '%' });
const flag = name => ({ name, role: 'indicator', bool: true });
const sensor = name => ({ name, role: 'value', states: SENSOR_STATES });

const heatpump = {
    dhw_top_temperature_c: temp(t('Hot water tank top', 'Warmwasser-Boiler oben')),
    buffer_bottom_temperature_c: temp(t('Buffer tank bottom', 'Puffer unten')),
    heating_flow_after_mixer_temperature_c: temp(t('Heating circuit flow after mixer', 'Heizkreis-Vorlauf hinter Mischer')),
    flow_temperature_c: temp(t('Heat pump flow', 'WP-Vorlauf')),
    return_temperature_c: temp(t('Heat pump return', 'WP-Rücklauf')),
    outdoor_temperature_c: temp(t('Outdoor temperature', 'Außentemperatur')),
    heatpump_target_temperature_c: temp(t('Current target temperature', 'Aktuelle Solltemperatur')),
    electrical_power_w: power(t('Electrical power', 'Elektrische Leistung')),
    thermal_power_w: power(t('Thermal power', 'Heizleistung')),
    cop: { name: t('Current coefficient of performance (COP)', 'Aktuelle Leistungszahl (COP)'), role: 'value' },
    heating_water_mass_flow_kg_s: { name: t('Heating water mass flow', 'Heizwassermassenstrom'), role: 'value.flow', unit: 'kg/s' },
    circulation_pump_percent: percent(t('Heat pump circulation pump setpoint', 'Stellwert WP-Umwälzpumpe')),
    compressor_setpoint_percent: percent(t('Compressor setpoint', 'Kompressorstellwert')),
    heating_circuit_pump_state: flag(t('Heating circuit pump on', 'Heizkreispumpe ein')),
    heating_circuit_mixer_raw: { name: t('Heating circuit mixer setpoint (raw value)', 'Heizkreismischer-Stellwert (Rohwert)'), role: 'value' },
    dhw_heat_request: flag(t('Hot water heat request', 'Warmwasser-Wärmeanforderung')),
    buffer_heat_request: flag(t('Buffer heat request', 'Puffer-Wärmeanforderung')),
    consuming_excess_energy: { name: t('Excess energy use reported by the heat pump controller', 'Überschussnutzung laut WP-Regelung'), role: 'value' },
    operating_status_code: { name: t('Operating status', 'Betriebsstatus'), role: 'value', states: HEATPUMP_OPERATING_STATES },
    operating_substatus_code: { name: t('Sequence status', 'Ablaufstatus'), role: 'value' },
    dhw_sensor_status_code: sensor(t('Sensor status hot water', 'Sensorstatus Warmwasser')),
    buffer_bottom_sensor_status_code: sensor(t('Sensor status buffer bottom', 'Sensorstatus Puffer unten')),
    heating_flow_after_mixer_sensor_status_code: sensor(t('Sensor status heating circuit flow', 'Sensorstatus Heizkreis-Vorlauf')),
    flow_sensor_status_code: sensor(t('Sensor status heat pump flow', 'Sensorstatus WP-Vorlauf')),
    outdoor_sensor_status_code: sensor(t('Sensor status outdoor temperature', 'Sensorstatus Außentemperatur')),
};

const butler = {
    battery_soc_percent: { name: t('Battery state of charge', 'Batterieladestand'), role: 'value.battery', unit: '%' },
    battery_charge_power_w: power(t('Battery charging power', 'Batterieladeleistung')),
    battery_discharge_power_w: power(t('Battery discharging power', 'Batterieentladeleistung')),
    battery_power_signed_w: power(t('Battery power (+ discharging, − charging)', 'Batterieleistung (+ Entladen, − Laden)')),
    battery_charge_discharge_status_code: {
        name: t('Battery mode', 'Batteriemodus'),
        role: 'value',
        states: { 0: 'Discharging', 1: 'Charging' },
    },
    grid_import_power_w: power(t('Grid import', 'Netzbezug')),
    grid_export_power_w: power(t('Grid export', 'Netzeinspeisung')),
    grid_total_power_signed_w: power(t('Grid power total (− import, + export)', 'Netzleistung gesamt (− Bezug, + Einspeisung)')),
    grid_phase_a_power_signed_w: power(t('Grid power phase A (− import, + export)', 'Netzleistung Phase A (− Bezug, + Einspeisung)')),
    grid_phase_b_power_signed_w: power(t('Grid power phase B (− import, + export)', 'Netzleistung Phase B (− Bezug, + Einspeisung)')),
    grid_phase_c_power_signed_w: power(t('Grid power phase C (− import, + export)', 'Netzleistung Phase C (− Bezug, + Einspeisung)')),
    pv_total_power_w: power(t('PV total power', 'PV-Gesamtleistung')),
    pv1_power_w: power(t('PV input 1', 'PV-Eingang 1')),
    pv2_power_w: power(t('PV input 2', 'PV-Eingang 2')),
    inverter_ac_power_signed_w: power(t('Inverter AC power', 'Wechselrichter-AC-Leistung')),
    inverter_operating_status_code: { name: t('Inverter status', 'Wechselrichterstatus'), role: 'value', states: INVERTER_STATES },
};

/** Devices: channel ID in ioBroker, display name, known fields. */
const DEVICES = {
    heatpump: { name: t('M-TEC heat pump', 'M-TEC Wärmepumpe'), fields: heatpump },
    butler: { name: t('M-TEC Energy Butler', 'M-TEC Energy Butler'), fields: butler },
};

/**
 * Builds the common object of a data point.
 *
 * @param {string} field field name
 * @param {object} [def] definition from DEVICES; without one, a generic number is created
 */
function stateCommon(field, def) {
    const d = def || { name: field, role: 'value' };
    const common = {
        name: d.name,
        type: d.bool ? 'boolean' : 'number',
        role: d.role,
        read: true,
        write: false,
    };
    if (d.unit) {
        common.unit = d.unit;
    }
    if (d.states) {
        common.states = d.states;
    }
    return common;
}

module.exports = { DEVICES, stateCommon, t };
