import {
  defineClientExtension,
  type AgentAnnotationsExtensionContext,
  type PanelContribution,
  type StudioPublicApi,
  type ToolbarContribution,
} from "../../src/extension/index.js";

const useStudio = (studio: StudioPublicApi): void => {
  studio.getSnapshot().task.annotations;
  studio.subscribe((snapshot) => snapshot.captureMode);
  studio.commands.capture.startPick();
  void studio.commands.annotations.copyOpen();
  void studio.commands.annotations.removeAll();
  studio.commands.markers.focus("annotation-id");
  const summary = studio.commands.annotations.targetSummary("annotation-id");
  if (summary.reason === "identity mismatch") void summary.resolved;
  const reason: "unresolved" | "identity mismatch" | "identity unverifiable" | "iframe unsupported" | null = summary.reason;
  void reason;
  studio.commands.markers.highlight("annotation-id");
  studio.commands.markers.highlight(null);
  studio.commands.panels.open("public-consumer:consumer-panel");
  studio.commands.toolbar.toggleCollapsed();
  void studio.commands.exporters.format("public-consumer:exporter-id");
  void studio.commands.exporters.copy("public-consumer:exporter-id");
  // @ts-expect-error Internal setters are not public.
  studio.setMode("pick");
  // @ts-expect-error Internal setters are not public.
  studio.setTask(studio.getSnapshot().task);
  // @ts-expect-error Internal setters are not public.
  studio.setAnnotations([]);
  // @ts-expect-error Internal setters are not public.
  studio.setOpen(true);
};

const toolbar: ToolbarContribution = {
  id: "consumer-action",
  group: "host",
  label: "Consumer action",
  icon: () => null,
  kind: "action",
  execute: ({ studio }) => {
    useStudio(studio);
  },
};
const panel: PanelContribution = {
  id: "consumer-panel",
  title: "Consumer panel",
  render: ({ studio, close }) => {
    useStudio(studio);
    close();
    return null;
  },
};

defineClientExtension({
  id: "public-consumer",
  apiVersion: 1,
  setup(context: AgentAnnotationsExtensionContext) {
    useStudio(context.studio);
    // @ts-expect-error The public context cannot expose the raw transport.
    context.transport;
  },
  toolbar: [toolbar],
  panels: [panel],
});

type DispatchLeak = Extract<keyof AgentAnnotationsExtensionContext, "dispatch">;
// @ts-expect-error The public context cannot expose React.Dispatch.
const noDispatch: DispatchLeak = "dispatch";
void noDispatch;
