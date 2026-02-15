import { anzTemplateV1 } from "@/lib/templates/anz_v1";
import { DevTemplate, DevTemplateDetection } from "@/lib/templates/types";

const templates: DevTemplate[] = [anzTemplateV1];

export function listDevTemplates() {
  return templates;
}

export function detectDevTemplate(text: string) {
  let bestTemplate: DevTemplate | null = null;
  let bestDetection: DevTemplateDetection | null = null;

  for (const template of templates) {
    const detection = template.detect(text);
    if (!detection.matched) continue;
    if (!bestDetection || detection.confidence > bestDetection.confidence) {
      bestTemplate = template;
      bestDetection = detection;
    }
  }

  if (!bestTemplate || !bestDetection) {
    return {
      template: null,
      detection: {
        matched: false,
        confidence: 0,
        bankId: "unknown",
        templateId: "unknown",
        mode: "unknown",
        evidence: [],
      } satisfies DevTemplateDetection,
    };
  }

  return { template: bestTemplate, detection: bestDetection };
}
