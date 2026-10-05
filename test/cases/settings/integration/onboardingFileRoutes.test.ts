import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness.ts";

test("each offered onboarding model saves its key and resolves the selected file route", async (t) => {
  let root: ReturnType<typeof createRoot> | undefined;
  t.after(async () => {
    if (root) await React.act(async () => root!.unmount());
  });
  const writes: Array<{ method: string; key: string }> = [];

  const methods = [
    "saveOpenAIKey",
    "saveGeminiKey",
    "saveGroqKey",
    "saveXaiKey",
    "saveMistralKey",
    "saveTinfoilKey",
    "saveDeepgramKey",
    "saveElevenLabsKey",
    "saveCustomTranscriptionKey",
  ];

  installBrowserGlobals(t, {
    initialStorage: { cloudTranscriptionMode: "byok" },
    window: {
      dispatchEvent: () => true,
      electronAPI: Object.fromEntries(
        methods.map((method) => [
          method,
          async (key: string) => {
            writes.push({ method, key });

            return { success: true };
          },
        ])
      ),
    },
  });

  const ui: {
    selects: Record<string, any>;
    inputs: Record<string, any>;
    key?: any;
    connection?: any;
  } = { selects: {}, inputs: {} };

  const globals = globalThis as Record<string, unknown>;
  globals.__onboardingRouteUi = ui;
  t.after(() => {
    delete globals.__onboardingRouteUi;
  });

  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next":
        'export const initReactI18next={type:"3rdParty",init(){}};export function useTranslation(){return {t:key=>key};}',
      "/ui/SelectField":
        "export function SelectField(props){globalThis.__onboardingRouteUi.selects[props.ariaLabel]=props;return null;}",
      "/ui/input":
        "export function Input(props){globalThis.__onboardingRouteUi.key=props;globalThis.__onboardingRouteUi.inputs[props.placeholder||props.type]=props;return null;}",
      "/ui/ProviderIcon": "export function ProviderIcon(){return null;}",
      "./ProviderConnectionTest":
        "export default function Test(props){globalThis.__onboardingRouteUi.connection=props;return null;}",
    },
  });

  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    uploadCloudTranscriptionProvider: "openai",
    uploadCloudTranscriptionModel: "gpt-4o-mini-transcribe",
  });
  const { resolveTranscriptionRoute } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");

  const { selectResolvedUploadTranscription, selectResolvedMeetingTranscription } =
    await vite.ssrLoadModule("/config/settingsSelectors.ts");

  let commit!: () => Promise<void>;
  let proceeds = 0;
  const container = installHookDom(t);
  root = createRoot(container as unknown as Element);
  await React.act(async () =>
    root!.render(
      React.createElement(ByokProviderStep, {
        onConnectionChange() {},
        onProceed() {
          proceeds++;
        },
        onFooterContinue(next: typeof commit) {
          commit = next;
        },
      })
    )
  );
  const providerLabel = "onboarding.rehaul.provider.providerLabel";
  const modelLabel = "onboarding.rehaul.provider.modelLabel";

  const offered = ui.selects[providerLabel].options.map(
    (option: { id: string }) => option.id
  ) as string[];

  assert.equal(offered.includes("assemblyai"), false);
  assert.equal(offered.includes("corti"), false);
  assert.ok(offered.includes("openai") && offered.includes("deepgram"));
  let combinations = 0;

  for (const provider of offered) {
    await React.act(async () => ui.selects[providerLabel].onChange(provider));

    const models = ui.selects[modelLabel].options.map(
      (option: { id: string }) => option.id
    ) as string[];

    assert.ok(models.length);

    for (const model of models) {
      await React.act(async () => {
        ui.selects[modelLabel].onChange(model);
        ui.key.onChange({ target: { value: "synthetic-key" } });
      });
      await React.act(async () => ui.connection.onSuccessChange(true));
      const before = writes.length;
      await React.act(async () => {
        await commit();
      });
      assert.equal(writes.length, before + 1, `${provider}/${model} has a secure setter`);
      assert.equal(writes.at(-1)?.key, "synthetic-key");
      assert.equal(
        useSettingsStore.getState().cloudTranscriptionProvider,
        provider,
        "base selected provider"
      );
      assert.equal(
        useSettingsStore.getState().uploadCloudTranscriptionProvider,
        provider,
        "Upload selected provider"
      );

      const route = resolveTranscriptionRoute({
        settings: selectResolvedUploadTranscription(useSettingsStore.getState()),
      });

      assert.notEqual(route.transport, "error", `${provider}/${model}`);
      assert.equal(route.provider, provider);
      combinations++;
    }
  }

  assert.equal(proceeds, combinations);
  await React.act(async () =>
    useSettingsStore.setState({
      remoteTranscriptionUrl: "https://old.example.invalid/v1",
      meetingRemoteTranscriptionUrl: "https://old-meeting.example.invalid/v1",
      uploadCloudTranscriptionBaseUrl: "https://old-upload.example.invalid/v1",
      meetingCloudTranscriptionBaseUrl: "https://old-custom.example.invalid/v1",
    })
  );

  const findToggle = (node: any): any =>
    node.attributes?.get("role") === "checkbox"
      ? node
      : node.childNodes?.map(findToggle).find(Boolean);

  const toggle = findToggle(container);
  assert.ok(toggle);
  const props = toggle[Object.keys(toggle).find((key) => key.startsWith("__reactProps$"))!];
  await React.act(async () => props.onClick());
  const endpoint = "https://new.example.invalid/v1";
  await React.act(async () => {
    ui.inputs["onboarding.rehaul.provider.endpointPlaceholder"].onChange({
      target: { value: endpoint },
    });
    ui.inputs["onboarding.rehaul.provider.modelIdPlaceholder"].onChange({
      target: { value: "chosen-model" },
    });
  });
  await React.act(async () => ui.connection.onSuccessChange(true));
  await React.act(async () => {
    await commit();
  });
  assert.equal(proceeds, combinations + 1);

  for (const select of [selectResolvedUploadTranscription, selectResolvedMeetingTranscription]) {
    const route = resolveTranscriptionRoute({ settings: select(useSettingsStore.getState()) });
    assert.equal(route.transport, "http-batch");
    assert.equal(route.endpoint, endpoint + "/audio/transcriptions");
    assert.equal(route.model, "chosen-model");
  }
});
