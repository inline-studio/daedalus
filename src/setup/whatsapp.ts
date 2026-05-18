import prompts from "prompts";
import {
  askDefaultAgent,
  backendForDisable,
  confirm,
  persistChannelConfig,
  persistChannelDisable,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
} from "./base.js";
import { secretPrompt } from "./secret-prompt.js";

interface PhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

async function validatePhoneNumber(token: string, phoneNumberId: string): Promise<PhoneInfo> {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}?fields=id,display_phone_number,verified_name`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  } & PhoneInfo;
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  if (!json.id) throw new Error("response missing 'id'");
  return json;
}

export const whatsappSetup: ChannelSetup = {
  id: "whatsapp",
  title: "WhatsApp (Meta Cloud API)",
  summary:
    "Set up WhatsApp via Meta's Cloud API. You'll need an access token and a phone_number_id from your Meta App.",

  async run(ctx: SetupContext): Promise<void> {
    console.log(`\n${this.title} setup — ${this.summary}\n`);
    console.log("Where to find these:");
    console.log("  1. https://developers.facebook.com/apps → your app → WhatsApp → API Setup");
    console.log("  2. 'Temporary access token' (24h) or generate a permanent System User token");
    console.log("  3. 'Phone number ID' shown on the same page (a long numeric string)\n");

    const token =
      (await secretPrompt({
        message: "WhatsApp access token:",
        validate: (v: string) => v.length > 30 || "token looks too short",
      })) ?? "";
    if (!token) throw new Error("cancelled");

    const phoneRes = await prompts({
      type: "text",
      name: "phoneNumberId",
      message: "Phone number ID:",
      validate: (v: string) => /^\d{8,}$/.test(v) || "expected a numeric ID (8+ digits)",
    });
    const phoneNumberId = (phoneRes.phoneNumberId as string | undefined) ?? "";
    if (!phoneNumberId) throw new Error("cancelled");

    let info: PhoneInfo;
    try {
      process.stdout.write("validating with Meta… ");
      info = await validatePhoneNumber(token, phoneNumberId);
      process.stdout.write(`OK (${info.display_phone_number ?? phoneNumberId}${info.verified_name ? `, ${info.verified_name}` : ""})\n`);
    } catch (err) {
      process.stdout.write("FAILED\n");
      throw new Error((err as Error).message);
    }

    const proceed = await confirm("Continue?", true);
    if (!proceed) throw new Error("cancelled");

    const defaultAgent = await askDefaultAgent(ctx.brainPath);

    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates: {
        WHATSAPP_ACCESS_TOKEN: token,
        WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
      },
      yamlEdits: [
        { keyPath: ["channels", "whatsapp", "enabled"], value: true },
        { keyPath: ["channels", "whatsapp", "defaultAgent"], value: defaultAgent },
        { keyPath: ["channels", "whatsapp", "accessToken"], value: "${WHATSAPP_ACCESS_TOKEN}" },
        { keyPath: ["channels", "whatsapp", "phoneNumberId"], value: "${WHATSAPP_PHONE_NUMBER_ID}" },
      ],
      channelId: "whatsapp",
    });
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will delete saved WhatsApp credentials and remove all whatsapp config keys. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "whatsapp",
      yamlSets: opts.purge ? [] : [{ keyPath: ["channels", "whatsapp", "enabled"], value: false }],
      yamlPurge: [["channels", "whatsapp"]],
      secretsToPurge: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });
  },
};
