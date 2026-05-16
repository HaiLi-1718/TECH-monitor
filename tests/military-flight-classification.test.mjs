import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  identifyCommercialCallsign,
  detectAircraftTypeFromSourceMeta,
  deriveSourceHints,
  deriveOperatorFromSourceMeta,
  filterMilitaryFlights,
} from '../scripts/seed-military-flights.mjs';

function makeState({
  icao24,
  callsign,
  country = '',
  lon = 0,
  lat = 0,
  sourceMeta,
}) {
  return [
    icao24,
    callsign,
    country,
    null,
    Date.now() / 1000,
    lon,
    lat,
    0,
    false,
    0,
    0,
    0,
    null,
    null,
    null,
    sourceMeta || {},
  ];
}

describe('military flight classification', () => {
  it('identifies commercial callsigns beyond the static 3-letter set', () => {
    assert.ok(identifyCommercialCallsign('CLX283'));
    assert.ok(identifyCommercialCallsign('QR3251'));
    assert.ok(identifyCommercialCallsign('QTR8VG'));
  });

  it('derives military hints and aircraft type from source metadata', () => {
    const sourceMeta = {
      operatorName: 'US Air Force',
      aircraftTypeLabel: 'KC-135 tanker',
      aircraftModel: 'Boeing KC-135R',
    };
    const hints = deriveSourceHints(sourceMeta);
    assert.equal(hints.militaryHint, true);
    assert.equal(detectAircraftTypeFromSourceMeta(sourceMeta), 'tanker');
  });

  it('does not mark military airlift metadata as commercial just because it includes cargo language', () => {
    const sourceMeta = {
      operatorName: 'Qatar Emiri Air Force',
      aircraftTypeLabel: 'military cargo transport',
      aircraftModel: 'C-17 Globemaster',
    };
    const hints = deriveSourceHints(sourceMeta);
    assert.equal(hints.militaryHint, true);
    assert.equal(hints.militaryOperatorHint, true);
    assert.equal(hints.commercialHint, false);
  });

  it('rejects commercial-looking flights even when they match an ambiguous hex range', () => {
    const state = makeState({
      icao24: '06A250',
      callsign: 'QTR8VG',
      country: 'Qatar',
      lon: 51.6,
      lat: 25.2,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 0);
    assert.equal(audit.rejectedByReason.commercial_callsign_override, 1);
  });

  it('rejects ambiguous hex-only flights without supporting source metadata', () => {
    const state = makeState({
      icao24: '06A255',
      callsign: '',
      country: 'Qatar',
      lon: 51.6,
      lat: 25.2,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 0);
    assert.equal(audit.rejectedByReason.ambiguous_hex_without_support, 1);
  });

  it('keeps trusted military hex matches and records admission reason', () => {
    const state = makeState({
      icao24: 'ADF800',
      callsign: '',
      country: 'United States',
      lon: 120.7,
      lat: 15.1,
    });

    const { flights, audit } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'hex_trusted');
    assert.equal(audit.admittedByReason.hex_trusted, 1);
  });

  it('admits ambiguous hex matches when source metadata clearly indicates military context', () => {
    const state = makeState({
      icao24: '06A255',
      callsign: '',
      country: 'Qatar',
      lon: 25.1,
      lat: 51.6,
      sourceMeta: {
        operatorName: 'Qatar Emiri Air Force',
        aircraftTypeLabel: 'military transport',
        aircraftModel: 'C-17 Globemaster',
      },
    });

    const { flights } = filterMilitaryFlights([state]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'hex_supported_by_source');
    assert.equal(flights[0].aircraftType, 'transport');
    assert.equal(flights[0].classificationReason, 'source_metadata');
    assert.equal(flights[0].operator, 'qeaf');
    assert.equal(flights[0].operatorCountry, 'Qatar');
  });

  it('derives a stable operator identity from source metadata for ambiguous military ranges', () => {
    const sourceMeta = {
      operatorName: 'Qatar Emiri Air Force',
      aircraftTypeLabel: 'military transport',
      aircraftModel: 'C-17 Globemaster',
    };
    const operator = deriveOperatorFromSourceMeta(sourceMeta);
    assert.deepEqual(operator, {
      operator: 'qeaf',
      operatorCountry: 'Qatar',
    });
  });
});
