import { createElement } from "react";

import type { AgentAnnotationsIconProps } from "../types/index.js";

const icon = (...paths: string[]) =>
  ({ className, size = 18 }: AgentAnnotationsIconProps) =>
    createElement(
      "svg",
      {
        "aria-hidden": true,
        className,
        fill: "none",
        focusable: "false",
        height: size,
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeWidth: 2,
        viewBox: "0 0 24 24",
        width: size,
      },
      ...paths.map((d) => createElement("path", { d, key: d }))
    );

export const PickIcon = icon("M5 3l6.5 16 2.5-6 6-2.5L5 3z");
export const MultiIcon = icon("M8 8h11v11H8z", "M5 16H4V4h12v1");
export const AreaIcon = icon("M4 9V4h5", "M15 4h5v5", "M20 15v5h-5", "M9 20H4v-5");
export const CopyIcon = icon("M9 9h11v11H9z", "M4 15V4h11v5");
export const MarkersIcon = icon("M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z");
export const AnnotationsIcon = icon("M4 5h16v11H9l-5 4V5z", "M8 9h8", "M8 12h6");
export const HelpIcon = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M9.5 9a2.5 2.5 0 1 1 3.2 2.4c-.7.3-.7.8-.7 1.6", "M12 17h.01");
export const CollapseIcon = icon("M9 18l-6-6 6-6", "M15 6l6 6-6 6");
export const GripIcon = icon("M9 5h.01", "M15 5h.01", "M9 12h.01", "M15 12h.01", "M9 19h.01", "M15 19h.01");
export const CloseIcon = icon("M6 6l12 12", "M18 6L6 18");
export const SaveIcon = icon("M5 12l4 4L19 6");
export const CompleteIcon = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M7 12l3 3 7-7");
export const ReopenIcon = icon("M4 4v6h6", "M4.5 9a8 8 0 1 1-1 6");
export const DeleteIcon = icon("M4 7h16", "M9 7V4h6v3", "M7 7l1 13h8l1-13", "M10 11v5", "M14 11v5");
export const CaptureIcon = icon("M4 8h3l2-3h6l2 3h3v11H4V8z", "M12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6z");
export const FallbackIcon = icon("M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0");
