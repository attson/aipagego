import { create } from "zustand";

export type DrawerKind = "history" | "tools" | "settings" | "debug" | "scenarios" | "collect" | "workflow" | "jobs" | "connectors";

type UiState = {
  /** Which right-side drawer is currently visible. Global (not per-session). */
  openedDrawer: DrawerKind | null;
  /** Optional sub-path inside the drawer (e.g. selected tool id for ToolDetail). */
  drawerSubPath: string | null;
  open: (kind: DrawerKind, subPath?: string | null) => void;
  close: () => void;
};

export const useUi = create<UiState>((set) => ({
  openedDrawer: null,
  drawerSubPath: null,
  open: (kind, subPath = null) => set({ openedDrawer: kind, drawerSubPath: subPath }),
  close: () => set({ openedDrawer: null, drawerSubPath: null }),
}));
