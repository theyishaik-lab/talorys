import { createContext, useContext } from "react";

/** Opens / closes the chat shell's drawer from anywhere inside it (the top bar's menu button). */
export interface DrawerApi {
  open: () => void;
  close: () => void;
}
export const DrawerContext = createContext<DrawerApi>({ open: () => {}, close: () => {} });
export const useDrawer = () => useContext(DrawerContext);
