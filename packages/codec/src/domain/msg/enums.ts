/**
 * Message-level enums + the enum-mapping helper used by row_to_message.
 *
 * `ChatType` is vendored from the soon-to-be-deleted `@weq/types` (which is
 * itself vendored from QQ NT). `MsgType` / `SendType` / `SendStatus` live next
 * to the wire schema in `proto/msg/40900.ts` and are imported there.
 */

/**
 * 聊天类型枚举 — value of SQL column 40010.
 * Vendored from QQ NT (KCHATTYPE*).
 */
export enum ChatType {
  KCHATTYPEADELIE = 42,
  KCHATTYPEBUDDYNOTIFY = 5,
  KCHATTYPEC2C = 1,
  KCHATTYPECIRCLE = 113,
  KCHATTYPEDATALINE = 8,
  KCHATTYPEDATALINEMQQ = 134,
  KCHATTYPEDISC = 3,
  KCHATTYPEFAV = 41,
  KCHATTYPEGAMEMESSAGE = 105,
  KCHATTYPEGAMEMESSAGEFOLDER = 116,
  KCHATTYPEGROUP = 2,
  KCHATTYPEGROUPBLESS = 133,
  KCHATTYPEGROUPGUILD = 9,
  KCHATTYPEGROUPHELPER = 7,
  KCHATTYPEGROUPNOTIFY = 6,
  KCHATTYPEGUILD = 4,
  KCHATTYPEGUILDMETA = 16,
  KCHATTYPEMATCHFRIEND = 104,
  KCHATTYPEMATCHFRIENDFOLDER = 109,
  KCHATTYPENEARBY = 106,
  KCHATTYPENEARBYASSISTANT = 107,
  KCHATTYPENEARBYFOLDER = 110,
  KCHATTYPENEARBYHELLOFOLDER = 112,
  KCHATTYPENEARBYINTERACT = 108,
  KCHATTYPEQQNOTIFY = 132,
  KCHATTYPERELATEACCOUNT = 131,
  KCHATTYPESERVICEASSISTANT = 118,
  KCHATTYPESERVICEASSISTANTSUB = 201,
  KCHATTYPESQUAREPUBLIC = 115,
  KCHATTYPESUBSCRIBEFOLDER = 30,
  KCHATTYPETEMPADDRESSBOOK = 111,
  KCHATTYPETEMPBUSSINESSCRM = 102,
  KCHATTYPETEMPC2CFROMGROUP = 100,
  KCHATTYPETEMPC2CFROMUNKNOWN = 99,
  KCHATTYPETEMPFRIENDVERIFY = 101,
  KCHATTYPETEMPNEARBYPRO = 119,
  KCHATTYPETEMPPUBLICACCOUNT = 103,
  KCHATTYPETEMPWPA = 117,
  KCHATTYPEUNKNOWN = 0,
  KCHATTYPEWEIYUN = 40,
}

/**
 * Reverse-lookup a numeric enum: returns the member NAME when `value` is a
 * defined member, otherwise returns the raw number unchanged. Lets callers
 * surface "MULTI_FORWARD" for known values while still round-tripping unknown
 * ones for later RE.
 */
export function enumName(
  enumObj: Record<number, string>,
  value: number,
): string | number {
  const name = enumObj[value];
  return typeof name === 'string' ? name : value;
}
