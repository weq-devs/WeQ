/**
 * 40801 — per-message decoration record (气泡/字体/挂件等装扮数据).
 *
 * The column stores a protobuf whose outermost field is tag 40801 (LEN/nested).
 * Inside that field, the actual dress tags run from ~41501 to ~41535 plus a few
 * sparse higher ones. Full-scan of the Android backup (35 683 rows, 80.3% fill):
 *
 *   41501  uint64  — unknown signature / uid hash (×28714)
 *   41502  uint32  — proto version flag (4 / 16 / 12 / 23)
 *   41510  uint32  — bubble skin itemId          ← CONFIRMED
 *   41511  uint32  — unknown (occasionally large: ~1 497 155 718; usually 0-8)
 *   41512  uint32  — bubble revision / version tag (~2480–2905)
 *   41513  bool    — unknown flag
 *   41514  uint32  — unknown small int (30, 115, 46, 45)
 *   41516  uint32  — unknown small int (18, 119)
 *   41517  bool    — unknown flag
 *   41518  uint32  — rare (~27 rows), small int ~20182–20188; possibly another itemId
 *   41519  uint32  — font-related int (258, 337, 339 …)
 *   41520  uint32  — font flags (1, 2, 4, 32)
 *   41521  uint32  — font sub-flag (1, 3)
 *   41522  uint32  — font sub-flag (3, 6, 8)
 *   41523  bool    — unknown flag
 *   41524  uint32  — similar to 41519
 *   41525  uint32  — chat-font skin itemId        ← CONFIRMED
 *   41528  uint32  — widget / 挂件 itemId (~104 228–156 358)  ← CONFIRMED
 *   41529  bool    — unknown flag (always false in sample)
 *   41530  uint32  — unknown itemId (~154 016–156 365)
 *   41531  uint32  — unknown itemId (~65 536–164 024)
 *   41532  bool    — unknown flag
 *   41533  bool    — unknown flag
 *   41534  bool    — unknown flag
 *   41535  uint32  — unknown int (only value seen: 2000)
 *   41538  uint32  — rare (~327 rows); small int (2)
 *   41665  uint32  — rare (~176 rows); large uint32 (no pattern)
 *   42350  bool    — very rare (×2); always true
 *   43301  uint32  — rare (~101 rows); itemId ~101 579 449–102 115 491
 *   43302  bool    — rare (~101 rows); always true
 *   52180/52182/52381/52382  bool  — very rare (×15/×63)
 *   52346  nested  — rare (×96); child tag 29101 (bool)
 */

import { ProtoField, ScalarType } from '../../core';

/** The inner dress-info message (child of the tag-40801 wrapper). */
export const MsgDressWire = {
  flag41501: ProtoField(41501, ScalarType.UINT64, { optional: true }),
  protoVersion: ProtoField(41502, ScalarType.UINT32, { optional: true }),

  /** Bubble skin itemId (e.g. 2072805 "橘子汽水"). */
  bubbleId: ProtoField(41510, ScalarType.UINT32, { optional: true }),
  flag41511: ProtoField(41511, ScalarType.UINT32, { optional: true }),
  bubbleRevision: ProtoField(41512, ScalarType.UINT32, { optional: true }),
  flag41513: ProtoField(41513, ScalarType.BOOL, { optional: true }),
  flag41514: ProtoField(41514, ScalarType.UINT32, { optional: true }),
  flag41516: ProtoField(41516, ScalarType.UINT32, { optional: true }),
  flag41517: ProtoField(41517, ScalarType.BOOL, { optional: true }),
  flag41518: ProtoField(41518, ScalarType.UINT32, { optional: true }),

  flag41519: ProtoField(41519, ScalarType.UINT32, { optional: true }),
  flag41520: ProtoField(41520, ScalarType.UINT32, { optional: true }),
  flag41521: ProtoField(41521, ScalarType.UINT32, { optional: true }),
  flag41522: ProtoField(41522, ScalarType.UINT32, { optional: true }),
  flag41523: ProtoField(41523, ScalarType.BOOL, { optional: true }),
  flag41524: ProtoField(41524, ScalarType.UINT32, { optional: true }),

  /** Chat-font skin itemId (e.g. 20671). */
  fontId: ProtoField(41525, ScalarType.UINT32, { optional: true }),

  /** 挂件 (widget) itemId. */
  widgetId: ProtoField(41528, ScalarType.UINT32, { optional: true }),
  flag41529: ProtoField(41529, ScalarType.BOOL, { optional: true }),
  flag41530: ProtoField(41530, ScalarType.UINT32, { optional: true }),
  flag41531: ProtoField(41531, ScalarType.UINT32, { optional: true }),
  flag41532: ProtoField(41532, ScalarType.BOOL, { optional: true }),
  flag41533: ProtoField(41533, ScalarType.BOOL, { optional: true }),
  flag41534: ProtoField(41534, ScalarType.BOOL, { optional: true }),
  flag41535: ProtoField(41535, ScalarType.UINT32, { optional: true }),
};

/** Column 40801 wrapper — outermost tag is 40801, payload is MsgDressWire. */
export const MsgDressBody = {
  dress: ProtoField(40801, () => MsgDressWire, { optional: true }),
};
