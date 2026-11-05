export const I18nManager = { isRTL: false, allowRTL: () => {}, forceRTL: (v: boolean) => void (I18nManager.isRTL = v) };
export const Platform = { OS: "web" as string };
export const AppState = { currentState: "active", addEventListener: () => ({ remove: () => {} }) };
