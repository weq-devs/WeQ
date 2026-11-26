// Schema DSL
export * from './core';

// Schema-free decoder (for the Protobuf Lab and reverse-engineering)
export * as raw from './raw';

// Layer 2 — Element abstraction (wire ↔ Element)
export * from './element';

// Layer 3 — Domain Message (SqlRow + Element[] → Message)
export * from './domain';
export {
  POKE_DETAILED_ID,
  parsePokeDirection,
  parsePokeParties,
  type PokeParties,
  type PokePartiesInput,
} from './domain/msg/poke_event';

// Wire schemas are intentionally NOT re-exported wholesale here — import them
// directly from `@weq/codec/proto/<area>/<table>` so the import path stays
// self-documenting about which table is being parsed.
