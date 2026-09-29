import { EventEmitter } from "events";
import { globalShortcut, BrowserWindow } from "electron";
import debugLogger from "./debugLogger.js";
import { i18nMain } from "./i18nMain.js";
import { parseHotkeyList, type StoredHotkeyListValue } from "./hotkeyList.js";
import type { EnvironmentManager } from "./environment.js";

// Fallback hotkeys tried when primary hotkey registration fails on startup
const FALLBACK_HOTKEYS = ["F8", "F9", "Control+Shift+Space"];

// Default hotkey for dictation if no saved value exists
const DEFAULT_HOTKEY = "GLOBE";

// Right-side single modifiers are handled by native listeners, not globalShortcut
const RIGHT_SIDE_MODIFIER_PATTERN =
  /^Right(Control|Ctrl|Alt|Option|Shift|Command|Cmd|Super|Meta|Win)$/i;

export function isRightSideModifier(hotkey: string): boolean {
  return RIGHT_SIDE_MODIFIER_PATTERN.test(hotkey);
}

// Modifier-only combos are handled by the macOS native listener.
const MODIFIER_NAMES = new Set([
  "control",
  "ctrl",
  "alt",
  "option",
  "shift",
  "super",
  "meta",
  "win",
  "command",
  "cmd",
  "commandorcontrol",
  "cmdorctrl",
]);

export function isModifierOnlyHotkey(hotkey: string): boolean {
  if (!hotkey || !hotkey.includes("+")) return false;
  return hotkey.split("+").every((part) => MODIFIER_NAMES.has(part.toLowerCase()));
}

export function isGlobeLikeHotkey(hotkey: string): boolean {
  return hotkey === "GLOBE" || hotkey === "Fn";
}

export function isMouseButtonHotkey(hotkey: string): boolean {
  return /^MouseButton[45]$/i.test(hotkey || "");
}

// macOS only reports a release for keys the native listener watches (Globe,
// right-side modifiers, mouse buttons) and for modifier chords. A lone regular
// key goes through globalShortcut, which autorepeats and never reports release.
function lacksMacReleaseSignal(hotkey: string): boolean {
  return (
    !hotkey.includes("+") &&
    !isGlobeLikeHotkey(hotkey) &&
    !isMouseButtonHotkey(hotkey) &&
    !isRightSideModifier(hotkey)
  );
}

function normalizeToAccelerator(hotkey: string): string {
  return hotkey
    .replace(/\bRight(Command|Cmd)\b/g, "Command")
    .replace(/\bRight(Control|Ctrl)\b/g, "Control")
    .replace(/\bRight(Alt|Option)\b/g, "Alt")
    .replace(/\bRightShift\b/g, "Shift");
}

function isUnsupportedFnCombination(hotkey: string): boolean {
  return /^Fn\+/i.test(hotkey || "");
}

// Suggested alternative hotkeys when registration fails
const SUGGESTED_HOTKEYS = {
  single: ["F8", "F9", "F10", "Pause", "ScrollLock"],
  compound: ["Control+Super", "Control+Alt", "Control+Shift+Space", "Alt+F7"],
};

// A shared hotkey callback receives the hotkey that actually fired, so one
// callback can serve a slot's whole list.
export type HotkeyActivationCallback = (hotkey: string) => void;

export interface HotkeySlot {
  hotkeys: string[];
  callback: HotkeyActivationCallback | null;
  accelerators: (string | null)[];
}

// Registration outcomes are flat shapes, not discriminated unions: this file
// is compiled by the non-strictNullChecks renderer program too, where negative
// union narrowing is unavailable.
export interface HotkeyRegistrationResult {
  success: boolean;
  hotkey?: string;
  hotkeys?: string[];
  failures?: { hotkey: string; error?: string }[];
  error?: string;
  reason?: string;
  suggestions?: string[];
  conflictSlot?: string;
}

interface SingleHotkeyOutcome {
  success: boolean;
  hotkey: string;
  accelerator?: string | null;
  error?: string;
  reason?: string;
  suggestions?: string[];
}

interface SingleHotkeyFailureRecord {
  hotkey: string;
  error: string;
  reason?: string;
  suggestions?: string[];
}

type EnvironmentManagerCtor = new () => EnvironmentManager;

export class HotkeyManager extends EventEmitter {
  slots = new Map<string, HotkeySlot>();
  isInitialized = false;
  isListeningMode = false;
  activationMode: "push" | "tap" | null = null;
  mainWindow: BrowserWindow | null = null;

  constructor() {
    super();
    // Each slot holds a list of hotkeys (#936). `accelerators` mirrors `hotkeys`
    // index-for-index (null for native-listener entries).
    this.slots.set("dictation", { hotkeys: [DEFAULT_HOTKEY], callback: null, accelerators: [] });
  }

  // Ensure a slot exists and return it (slots always use the list shape).
  _ensureSlot(slotName: string): HotkeySlot {
    let slot = this.slots.get(slotName);
    if (!slot) {
      slot = { hotkeys: [], callback: null, accelerators: [] };
      this.slots.set(slotName, slot);
    }
    if (!Array.isArray(slot.hotkeys)) slot.hotkeys = [];
    if (!Array.isArray(slot.accelerators)) slot.accelerators = [];
    return slot;
  }

  // Primary (first) dictation hotkey; setting it replaces the whole list.
  get currentHotkey(): string | null {
    return this.slots.get("dictation")?.hotkeys?.[0] ?? null;
  }

  set currentHotkey(value: string | null) {
    const slot = this._ensureSlot("dictation");
    slot.hotkeys = value ? [value] : [];
    this.slots.set("dictation", slot);
  }

  get hotkeyCallback(): HotkeyActivationCallback | null {
    return this.slots.get("dictation")?.callback ?? null;
  }

  set hotkeyCallback(value: HotkeyActivationCallback | null) {
    const slot = this._ensureSlot("dictation");
    slot.callback = value;
    this.slots.set("dictation", slot);
  }

  setListeningMode(enabled: boolean): void {
    this.isListeningMode = enabled;
    debugLogger.log(`[HotkeyManager] Listening mode: ${enabled ? "enabled" : "disabled"}`);
  }

  isInListeningMode(): boolean {
    return this.isListeningMode;
  }

  getFailureReason(hotkey: string): {
    reason: "already_registered" | "registration_failed";
    message: string;
    suggestions: string[];
  } {
    if (globalShortcut.isRegistered(hotkey)) {
      return {
        reason: "already_registered",
        message: i18nMain.t("hotkey.errors.alreadyRegistered", { hotkey }),
        suggestions: this.getSuggestions(hotkey),
      };
    }

    return {
      reason: "registration_failed",
      message: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
      suggestions: this.getSuggestions(hotkey),
    };
  }

  getSuggestions(failedHotkey: string): string[] {
    const isCompound = failedHotkey.includes("+");
    let suggestions = isCompound ? [...SUGGESTED_HOTKEYS.compound] : [...SUGGESTED_HOTKEYS.single];

    if (isCompound) {
      suggestions = ["Control+Alt", "Alt+Command", "Command+Shift+Space"];
    }

    return suggestions.filter((s) => s !== failedHotkey).slice(0, 3);
  }

  async registerSlot(
    slotName: string,
    hotkeyInput: StoredHotkeyListValue,
    callback: HotkeyActivationCallback,
    options?: { atomic?: boolean }
  ): Promise<HotkeyRegistrationResult> {
    const hotkeys = parseHotkeyList(hotkeyInput);
    if (hotkeys.length === 0) {
      return {
        success: false,
        error: i18nMain.t("hotkey.errors.registrationFailed", {
          hotkey: String(hotkeyInput ?? ""),
        }),
      };
    }
    const result = this.setupShortcuts(hotkeys, callback, slotName, options);
    if (result.success) {
      const slot = this._ensureSlot(slotName);
      slot.callback = callback;
      this.slots.set(slotName, slot);
    }
    return result;
  }

  unregisterSlot(slotName: string): void {
    const slot = this.slots.get(slotName);
    if (!slot || !(slot.hotkeys?.length || slot.accelerators?.length)) return;

    // Release what was actually registered; native-listener entries are null.
    for (const accel of slot.accelerators || []) {
      if (!accel) continue;
      try {
        globalShortcut.unregister(accel);
      } catch {
        // already unregistered
      }
    }
    slot.hotkeys = [];
    slot.accelerators = [];
  }

  // Primary (first) hotkey for a slot — back-compat for callers that expect a
  // single value.
  getSlotHotkey(slotName: string): string | null {
    return this.slots.get(slotName)?.hotkeys?.[0] ?? null;
  }

  // Full list of hotkeys bound to a slot.
  getSlotHotkeys(slotName: string): string[] {
    return [...(this.slots.get(slotName)?.hotkeys ?? [])];
  }

  // True if `key` is one of the hotkeys bound to `slotName`.
  slotHasHotkey(slotName: string, key?: string | null): boolean {
    if (!key) return false;
    return (this.slots.get(slotName)?.hotkeys ?? []).includes(key);
  }

  // Name of the slot that owns `key`, or null. First match wins.
  findSlotByHotkey(key?: string | null): string | null {
    if (!key) return null;
    for (const [slotName, slot] of this.slots) {
      if ((slot.hotkeys ?? []).includes(key)) return slotName;
    }
    return null;
  }

  supportsPushToTalk(hotkey: string | null = this.currentHotkey): boolean {
    if (process.platform === "darwin" && hotkey && lacksMacReleaseSignal(hotkey)) {
      return false;
    }
    return true;
  }

  getPushToTalkUnavailableReason(hotkey: string | null = this.currentHotkey): string {
    if (process.platform === "darwin" && hotkey && lacksMacReleaseSignal(hotkey)) {
      return i18nMain.t("hotkey.errors.holdNeedsReleaseKey", { hotkey });
    }
    return i18nMain.t("hotkey.errors.registrationFailed", { hotkey });
  }

  async setActivationMode(mode: string): Promise<boolean> {
    const nextMode = mode === "push" ? "push" : "tap";
    if (this.activationMode === nextMode) return true;

    const hotkey = this.currentHotkey;
    if (nextMode === "push" && !this.supportsPushToTalk(hotkey)) {
      if (hotkey) {
        this.notifyHotkeyFailure(hotkey, {
          error: this.getPushToTalkUnavailableReason(hotkey),
        });
      }
      return false;
    }

    this.activationMode = nextMode;
    return true;
  }

  // Which mouse buttons the macOS listener must swallow for these slots, and
  // whether Gristmill owns Globe — if it does, macOS's own standalone Globe
  // action has to stand down.
  getMacNativeListenerConfig(slotNames: string[]): {
    mouseButtons: string[];
    suppressGlobeAction: boolean;
  } {
    const mouseButtons = new Set<string>();
    let suppressGlobeAction = false;

    for (const slotName of slotNames) {
      for (const hotkey of this.getSlotHotkeys(slotName)) {
        if (isMouseButtonHotkey(hotkey)) {
          mouseButtons.add(hotkey);
        } else if (isGlobeLikeHotkey(hotkey)) {
          suppressGlobeAction = true;
        }
      }
    }

    return { mouseButtons: [...mouseButtons], suppressGlobeAction };
  }

  // Register one hotkey without mutating any slot. `accelerator` is null for
  // hotkeys handled by native listeners.
  _registerSingleHotkey(hotkey: string, callback: HotkeyActivationCallback): SingleHotkeyOutcome {
    try {
      if (isMouseButtonHotkey(hotkey)) {
        debugLogger.log(
          `[HotkeyManager] Mouse button "${hotkey}" set - using macOS native listener`
        );
        return { success: true, hotkey, accelerator: null };
      }

      if (isGlobeLikeHotkey(hotkey)) {
        debugLogger.log(`[HotkeyManager] GLOBE/Fn key "${hotkey}" set successfully`);
        return { success: true, hotkey, accelerator: null };
      }

      // Electron cannot represent Fn as part of an accelerator. Registering
      // Fn+A as A claims an ordinary typing key globally, so only standalone
      // Globe/Fn (handled by the native listener above) is supported.
      if (isUnsupportedFnCombination(hotkey)) {
        return {
          success: false,
          hotkey,
          error: i18nMain.t("hotkey.errors.fnCombinationUnsupported", {
            defaultValue: "The Globe/Fn key can only be used by itself.",
          }),
          reason: "fn_combination_unsupported",
        };
      }

      if (isRightSideModifier(hotkey)) {
        debugLogger.log(
          `[HotkeyManager] Right-side modifier "${hotkey}" set - using native listener`
        );
        return { success: true, hotkey, accelerator: null };
      }

      const accelerator = normalizeToAccelerator(hotkey);

      // Pass the triggering hotkey so shared callbacks act on the one that fired.
      const success = globalShortcut.register(accelerator, () => callback(hotkey));
      debugLogger.log(`[HotkeyManager] Registration result for "${hotkey}": ${success}`);
      if (success) {
        return { success: true, hotkey, accelerator };
      }

      const failureInfo = this.getFailureReason(accelerator);
      debugLogger.error("Failed to register hotkey", { error: hotkey, ...failureInfo }, "hotkey");
      return {
        success: false,
        hotkey,
        error: failureInfo.message,
        reason: failureInfo.reason,
        suggestions: failureInfo.suggestions,
      };
    } catch (error) {
      debugLogger.error("Error setting up shortcut", { error: (error as Error).message }, "hotkey");
      return { success: false, hotkey, error: (error as Error).message };
    }
  }

  /**
   * Register a slot's hotkey list (string, comma-separated string, or array).
   * Default is best-effort: succeeds if at least one hotkey registers, with
   * individual failures in `result.failures`. `atomic: true` rolls the whole
   * slot back to its previous bindings on any failure.
   */
  setupShortcuts(
    hotkeyInput: StoredHotkeyListValue = DEFAULT_HOTKEY,
    callback: HotkeyActivationCallback,
    slotName: string = "dictation",
    { atomic = false }: { atomic?: boolean } = {}
  ): HotkeyRegistrationResult {
    if (!callback) {
      throw new Error(i18nMain.t("hotkey.errors.callbackRequired"));
    }

    const slot = this._ensureSlot(slotName);
    const desired = parseHotkeyList(hotkeyInput);

    debugLogger.log(
      `[HotkeyManager] Setting up hotkeys: "${desired.join(", ")}" for slot "${slotName}"`
    );
    debugLogger.log(
      `[HotkeyManager] Current hotkeys for slot: "${(slot.hotkeys || []).join(", ")}"`
    );

    if (desired.length === 0) {
      return {
        success: false,
        error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: "" }),
      };
    }

    // Reject if any desired hotkey conflicts with another slot before tearing
    // down this slot's current registration.
    for (const hotkey of desired) {
      const conflict = this._findSlotConflict(slotName, hotkey);
      if (conflict) return conflict;
    }

    const previousHotkeys = [...(slot.hotkeys || [])];
    const previousAccelerators = [...(slot.accelerators || [])];

    // Unregister this slot's previous globalShortcut accelerators.
    for (const prevAccel of previousAccelerators) {
      if (!prevAccel) continue;
      try {
        debugLogger.log(`[HotkeyManager] Unregistering previous accelerator: "${prevAccel}"`);
        globalShortcut.unregister(prevAccel);
      } catch (error) {
        debugLogger.warn(
          `[HotkeyManager] Skipping previous unregister for "${prevAccel}": ${(error as Error).message}`
        );
      }
    }

    const registeredHotkeys: string[] = [];
    const registeredAccelerators: (string | null)[] = [];
    const failures: SingleHotkeyFailureRecord[] = [];
    for (const hotkey of desired) {
      const res = this._registerSingleHotkey(hotkey, callback);
      if (res.success) {
        registeredHotkeys.push(res.hotkey);
        registeredAccelerators.push(res.accelerator ?? null);
      } else {
        failures.push({
          hotkey: res.hotkey,
          error: res.error ?? "",
          reason: res.reason,
          suggestions: res.suggestions,
        });
      }
    }

    if (registeredHotkeys.length === 0 || (atomic && failures.length > 0)) {
      // Roll back: unregister anything we just registered, then restore the
      // previous bindings so the slot keeps working.
      registeredAccelerators.forEach((accel) => {
        if (!accel) return;
        try {
          globalShortcut.unregister(accel);
        } catch {
          // already unregistered
        }
      });
      this._restorePreviousHotkeys(previousHotkeys, previousAccelerators, callback);
      slot.hotkeys = previousHotkeys;
      slot.accelerators = previousAccelerators;

      const failureInfo: Partial<SingleHotkeyFailureRecord> = failures[0] ?? {};
      let errorMessage =
        failureInfo.error || i18nMain.t("hotkey.errors.registrationFailed", { hotkey: desired[0] });
      const suggestions = failureInfo.suggestions || [];
      if (suggestions.length > 0) {
        errorMessage += ` ${i18nMain.t("hotkey.errors.trySuggestions", {
          suggestions: suggestions.join(", "),
        })}`;
      }
      return { success: false, error: errorMessage, reason: failureInfo.reason, suggestions };
    }

    slot.hotkeys = registeredHotkeys;
    slot.accelerators = registeredAccelerators;
    slot.callback = callback;
    debugLogger.log(
      `[HotkeyManager] Slot "${slotName}" registered: "${registeredHotkeys.join(", ")}"`
    );

    const result: HotkeyRegistrationResult = {
      success: true,
      hotkey: registeredHotkeys[0],
      hotkeys: registeredHotkeys,
    };
    if (failures.length > 0) {
      result.failures = failures.map((f) => ({ hotkey: f.hotkey, error: f.error }));
    }
    return result;
  }

  _findSlotConflict(slotName: string, hotkey: string): HotkeyRegistrationResult | null {
    const accelerator =
      isGlobeLikeHotkey(hotkey) ||
      isMouseButtonHotkey(hotkey) ||
      isRightSideModifier(hotkey) ||
      isModifierOnlyHotkey(hotkey)
        ? null
        : normalizeToAccelerator(hotkey);

    for (const [otherSlotName, otherSlot] of this.slots) {
      if (otherSlotName === slotName) continue;
      const otherHotkeys = otherSlot.hotkeys || [];
      const otherAccelerators = otherSlot.accelerators || [];
      const match =
        otherHotkeys.includes(hotkey) || (accelerator && otherAccelerators.includes(accelerator));
      if (match) {
        debugLogger.warn(
          `[HotkeyManager] Hotkey "${hotkey}" conflicts with slot "${otherSlotName}"`
        );
        return {
          success: false,
          error: i18nMain.t("hotkey.errors.slotConflict", {
            slot: otherSlotName,
            defaultValue: `This hotkey is already used for ${otherSlotName}`,
          }),
          reason: "slot_conflict",
          conflictSlot: otherSlotName,
        };
      }
    }
    return null;
  }

  _restorePreviousHotkeys(
    previousHotkeys: string[],
    previousAccelerators: (string | null)[],
    callback: HotkeyActivationCallback
  ): void {
    (previousHotkeys || []).forEach((previousHotkey, i) => {
      // Native-listener entries (null accelerator) are re-armed by the macOS
      // listener instead.
      const prevAccel = previousAccelerators?.[i];
      if (!prevAccel) return;
      try {
        const restored = globalShortcut.register(prevAccel, () => callback(previousHotkey));
        if (restored) {
          debugLogger.log(
            `[HotkeyManager] Restored previous hotkey "${previousHotkey}" after failed registration`
          );
        } else {
          debugLogger.warn(`[HotkeyManager] Could not restore previous hotkey "${previousHotkey}"`);
        }
      } catch (err) {
        debugLogger.warn(
          `[HotkeyManager] Exception restoring previous hotkey "${previousHotkey}": ${(err as Error).message}`
        );
      }
    });
  }

  async initializeHotkey(mainWindow: BrowserWindow, callback: HotkeyActivationCallback): Promise<void> {
    if (!mainWindow || !callback) {
      throw new Error("mainWindow and callback are required");
    }

    this.mainWindow = mainWindow;
    this.hotkeyCallback = callback;

    // Register from env var immediately if available, otherwise wait for page load.
    const envHotkey = process.env.DICTATION_KEY || "";
    if (envHotkey) {
      const result = this.setupShortcuts(envHotkey, callback);
      if (result.success) {
        this._notifyStartupRegistration(envHotkey, result);
        debugLogger.log(`[HotkeyManager] Hotkey "${envHotkey}" registered from env`);
      } else {
        debugLogger.log(`[HotkeyManager] Env hotkey "${envHotkey}" failed, waiting for page`);
        this.loadSavedHotkeyOrDefault(mainWindow, callback);
      }
    } else {
      const loadHotkey = () => this.loadSavedHotkeyOrDefault(mainWindow, callback);
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once("did-finish-load", loadHotkey);
      } else {
        loadHotkey();
      }
    }

    this.isInitialized = true;
  }

  async loadSavedHotkeyOrDefault(
    mainWindow: BrowserWindow,
    callback: HotkeyActivationCallback
  ): Promise<void> {
    try {
      // First check file-based storage (environment variable) - more reliable
      let savedHotkey = process.env.DICTATION_KEY || "";

      // Fall back to localStorage if env var is empty
      if (!savedHotkey) {
        try {
          savedHotkey = (await mainWindow.webContents.executeJavaScript(`
            localStorage.getItem("dictationKey") || ""
          `)) as string;
        } catch (jsErr) {
          debugLogger.log(`[HotkeyManager] executeJavaScript failed: ${(jsErr as Error).message}`);
          savedHotkey = "";
        }

        // If we found a hotkey in localStorage but not in env, migrate it to .env file
        if (savedHotkey && savedHotkey.trim() !== "") {
          debugLogger.log(
            `[HotkeyManager] Migrating hotkey "${savedHotkey}" from localStorage to .env`
          );
          await this._persistHotkeyToEnvFile(savedHotkey);
        }
      }

      if (savedHotkey && savedHotkey.trim() !== "") {
        const result = this.setupShortcuts(savedHotkey, callback);
        if (result.success) {
          this._notifyStartupRegistration(savedHotkey, result);
          debugLogger.log(`[HotkeyManager] Restored saved hotkey: "${savedHotkey}"`);
          return;
        }
        debugLogger.log(`[HotkeyManager] Saved hotkey "${savedHotkey}" failed to register`);
        this.notifyHotkeyFailure(savedHotkey, result);
      }

      const defaultHotkey = this.getEffectiveDefaultHotkey();

      if (defaultHotkey === "GLOBE") {
        this.currentHotkey = "GLOBE";
        debugLogger.log("[HotkeyManager] Using GLOBE key as default on macOS");
        await this._persistHotkeyToEnvFile("GLOBE");
        return;
      }

      const result = this.setupShortcuts(defaultHotkey, callback);
      if (result.success) {
        debugLogger.log(
          `[HotkeyManager] Default hotkey "${defaultHotkey}" registered successfully`
        );
        return;
      }

      debugLogger.log(
        `[HotkeyManager] Default hotkey "${defaultHotkey}" failed, trying fallbacks...`
      );
      for (const fallback of FALLBACK_HOTKEYS) {
        const fallbackResult = this.setupShortcuts(fallback, callback);
        if (fallbackResult.success) {
          debugLogger.log(`[HotkeyManager] Fallback hotkey "${fallback}" registered successfully`);
          // Only persist to .env (for loadSavedHotkeyOrDefault fallback path).
          // Do NOT update localStorage — it holds the user's preferred hotkey so the
          // app retries it on next startup once the conflict is resolved.
          await this._persistHotkeyToEnvFile(fallback);
          this.notifyActiveHotkey(fallback);
          this.notifyHotkeyFallback(defaultHotkey, fallback);
          return;
        }
      }

      debugLogger.log("[HotkeyManager] All hotkey fallbacks failed");
      this.notifyHotkeyFailure(defaultHotkey, result);
    } catch (err) {
      debugLogger.error("Failed to initialize hotkey", { error: (err as Error).message }, "hotkey");
    } finally {
      this.emit("hotkey-loaded", this.currentHotkey);
    }
  }

  async _persistHotkeyToEnvFile(hotkey: string): Promise<void> {
    process.env.DICTATION_KEY = hotkey;
    try {
      const EnvironmentManagerCtor = require("./environment") as EnvironmentManagerCtor;
      const envManager = new EnvironmentManagerCtor();
      await envManager.saveAllKeysToEnvFile();
      debugLogger.log(`[HotkeyManager] Persisted hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn(
        "[HotkeyManager] Failed to persist hotkey to .env file:",
        (err as Error).message
      );
    }
  }

  async saveHotkeyToRenderer(hotkey: string): Promise<boolean> {
    // Save via EnvironmentManager (writes to .env file + process.env).
    // This is the authoritative backend store, read by getSavedHotkey() on next startup.
    try {
      const EnvironmentManagerCtor = require("./environment") as EnvironmentManagerCtor;
      const envManager = new EnvironmentManagerCtor();
      envManager.saveDictationKey(hotkey);
      debugLogger.log(`[HotkeyManager] Persisted hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to save dictation key to env:", (err as Error).message);
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send("setting-updated", { key: "dictationKey", value: hotkey });
        debugLogger.log(`[HotkeyManager] Sent dictationKey update to main window`);
        return true;
      } catch (err) {
        debugLogger.error("[HotkeyManager] Failed to send dictationKey update:", (err as Error).message);
        return false;
      }
    } else {
      debugLogger.warn("[HotkeyManager] Main window not available for setting sync");
      return false;
    }
  }

  async getSavedHotkey(): Promise<string> {
    // Read localStorage first (user's preferred hotkey), .env as backup.
    // localStorage keeps the preference even after a temporary fallback,
    // so the app retries the preferred hotkey on each startup and only
    // falls back again if the conflict still exists.
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        const lsKey = (await this.mainWindow.webContents.executeJavaScript(
          `localStorage.getItem("dictationKey") || ""`
        )) as string;
        if (lsKey && lsKey.trim() !== "") return lsKey;
      } catch (err) {
        debugLogger.log(
          "[HotkeyManager] Failed to read dictationKey from localStorage:",
          (err as Error).message
        );
      }
    }

    try {
      const EnvironmentManagerCtor = require("./environment") as EnvironmentManagerCtor;
      const envManager = new EnvironmentManagerCtor();
      const envKey = envManager.getDictationKey();
      if (envKey && envKey.trim() !== "") return envKey;
    } catch (err) {
      debugLogger.log("[HotkeyManager] Failed to read dictationKey from .env:", (err as Error).message);
    }

    return DEFAULT_HOTKEY;
  }

  /** Returns the default hotkey for macOS. */
  getEffectiveDefaultHotkey(): string {
    return DEFAULT_HOTKEY;
  }

  notifyActiveHotkey(hotkey: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("dictation-key-active", hotkey);
      }
    }
  }

  // Tell the renderer which hotkeys actually registered and which failed.
  _notifyStartupRegistration(requestedHotkey: string, result: HotkeyRegistrationResult): void {
    this.notifyActiveHotkey(result.hotkeys ? result.hotkeys.join(",") : requestedHotkey);
    for (const failure of result.failures || []) {
      this.notifyHotkeyFailure(failure.hotkey, failure);
    }
  }

  notifyHotkeyFallback(originalHotkey: string, fallbackHotkey: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-fallback-used", {
        original: originalHotkey,
        fallback: fallbackHotkey,
      });
    }
  }

  notifyHotkeyFailure(
    hotkey: string,
    result?: { error?: string; suggestions?: string[]; hotkey?: string } | null
  ): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-registration-failed", {
        hotkey,
        error: result?.error || i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
        suggestions: result?.suggestions || ["F8", "F9", "Control+Shift+Space"],
      });
    }
  }

  async updateHotkey(
    hotkeyInput: StoredHotkeyListValue,
    callback: HotkeyActivationCallback
  ): Promise<{ success: boolean; message: string; suggestions?: string[]; reason?: string }> {
    if (!callback) {
      throw new Error("Callback function is required for hotkey update");
    }

    try {
      const hotkeys = parseHotkeyList(hotkeyInput);
      if (hotkeys.length === 0) {
        return {
          success: false,
          message: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: "" }),
        };
      }
      const hotkeyStr = hotkeys.join(",");
      const primary = hotkeys[0];

      if (this.activationMode === "push" && !this.supportsPushToTalk(primary)) {
        return {
          success: false,
          message: this.getPushToTalkUnavailableReason(primary),
        };
      }

      for (const hotkey of hotkeys) {
        const conflict = this._findSlotConflict("dictation", hotkey);
        if (conflict) {
          return {
            success: false,
            message:
              conflict.error ??
              i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
            reason: conflict.reason,
          };
        }
      }

      const result = this.setupShortcuts(hotkeys, callback, "dictation", { atomic: true });
      if (result.success) {
        this.notifyActiveHotkey(hotkeyStr);
        const saved = await this.saveHotkeyToRenderer(hotkeyStr);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hotkey registered but failed to persist to localStorage"
          );
        }
        return { success: true, message: `Hotkey updated to: ${hotkeyStr}` };
      } else {
        return {
          success: false,
          message:
            result.error ??
            i18nMain.t("hotkey.errors.registrationFailed", { hotkey: hotkeyStr }),
          suggestions: result.suggestions,
        };
      }
    } catch (error) {
      debugLogger.error("[HotkeyManager] Failed to update hotkey:", (error as Error).message);
      return {
        success: false,
        message: `Failed to update hotkey: ${(error as Error).message}`,
      };
    }
  }

  getCurrentHotkey(): string | null {
    return this.currentHotkey;
  }

  unregisterAll(): void {
    for (const slotName of this.slots.keys()) {
      const slot = this.slots.get(slotName);
      if (slot) {
        slot.hotkeys = [];
        slot.accelerators = [];
      }
    }
    globalShortcut.unregisterAll();
  }

  isUsingNativeShortcut(): boolean {
    return false;
  }

  isHotkeyRegistered(hotkey: string): boolean {
    return globalShortcut.isRegistered(hotkey);
  }
}

module.exports = HotkeyManager;
module.exports.HotkeyManager = HotkeyManager;
module.exports.isGlobeLikeHotkey = isGlobeLikeHotkey;
module.exports.isModifierOnlyHotkey = isModifierOnlyHotkey;
module.exports.isRightSideModifier = isRightSideModifier;
module.exports.isMouseButtonHotkey = isMouseButtonHotkey;
