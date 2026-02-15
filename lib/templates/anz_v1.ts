import {
  DevTemplate,
  DevTemplateDetection,
  DevTemplateParseInput,
  DevTemplateParseOutput,
} from "@/lib/templates/types";

function detectAnzV1(_text: string): DevTemplateDetection {
  return {
    matched: false,
    confidence: 0,
    bankId: "anz",
    templateId: "anz_v1",
    mode: "unknown",
    evidence: [],
  };
}

function parseAnzV1(input: DevTemplateParseInput): DevTemplateParseOutput {
  const detection = detectAnzV1(input.text);
  return {
    bankId: "anz",
    templateId: "anz_v1",
    mode: detection.mode,
    accountId: "unknown",
    coverage: {},
    transactions: [],
    warnings: [
      {
        code: "ANZ_TEMPLATE_NOT_IMPLEMENTED",
        message: "ANZ parser is scaffolded but not implemented yet.",
        severity: "warning",
        confidence: 0,
      },
    ],
    debug: {
      continuityRatio: 0,
      checkedCount: 0,
      detection,
    },
  };
}

export const anzTemplateV1: DevTemplate = {
  id: "anz_v1",
  bankId: "anz",
  detect: detectAnzV1,
  parse: parseAnzV1,
};
