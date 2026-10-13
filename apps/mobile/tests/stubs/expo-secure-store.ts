const m = new Map<string, string>();
export const getItemAsync = async (k: string) => m.get(k) ?? null;
export const setItemAsync = async (k: string, v: string) => void m.set(k, v);
export const deleteItemAsync = async (k: string) => void m.delete(k);
