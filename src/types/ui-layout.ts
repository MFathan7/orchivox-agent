export const UI_LAYOUTS = ["orchivox", "reading", "review", "compact"] as const;
export type UiLayout = typeof UI_LAYOUTS[number];

export const DEFAULT_UI_LAYOUT: UiLayout = "orchivox";
