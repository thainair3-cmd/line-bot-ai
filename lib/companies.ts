// Issuing companies and default quote terms: the single place to edit them.
// Used by the admin group (stage 3) and the quote PDF (stage 4).
// The header matches the old Express quote: name, address and phone only
// (no tax ID, logo or bank account).

export type IssuerKey = "wujin" | "kreungyen";

export type Company = {
  key: IssuerKey;
  /** Short name used in admin commands and messages. */
  label: string;
  /** Matches the company name typed in "บริษัท #n ...". */
  aliases: RegExp;
  /** Full legal name printed on the quote. */
  name: string;
  address: string;
  phone: string;
};

export const COMPANIES: Record<IssuerKey, Company> = {
  wujin: {
    key: "wujin",
    label: "วู่จิน",
    aliases: /วู่?จิน|wu\s*jin/i,
    name: "บริษัท ไทยแน่ วู่จิน จำกัด",
    address: "224/50-52 ถนนหลานหลวง แขวงคลองมหานาค เขตป้อมปราบศัตรูพ่าย กรุงเทพฯ 10100",
    phone: "T:(092)514-1030 (02)-121-4505",
  },
  kreungyen: {
    key: "kreungyen",
    label: "เครื่องเย็น",
    aliases: /เครื่องเย็น|kreung\s*yen/i,
    name: "บริษัท ไทยแน่เครื่องเย็น จำกัด",
    address: "224,224/50-52 ถนน หลานหลวง แขวงคลองมหานาค เขตป้อมปราบศัตรูพ่าย กรุงเทพฯ 10100",
    phone: "Tel:(092)514-1030 (02)121-4505",
  },
};

/** Default terms printed on every quote. */
export const QUOTE_DEFAULTS = { validityDays: 3, payment: "เงินสด" } as const;

export function parseIssuer(text: string): IssuerKey | null {
  for (const c of Object.values(COMPANIES)) if (c.aliases.test(text)) return c.key;
  return null;
}
