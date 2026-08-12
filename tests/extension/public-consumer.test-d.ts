import {
  defineClientExtension,
  type AgentFeedbackExtensionContext,
  type PanelContribution,
  type StudioPublicApi,
  type ToolbarContribution,
} from "../../src/extension/index.js";

const useStudio = (studio: StudioPublicApi): void => {
  studio.getSnapshot().task.annotations;
  studio.subscribe((snapshot) => snapshot.captureMode);
  studio.commands.capture.startPick();
  void studio.commands.annotations.copyOpen();
  studio.commands.markers.focus("annotation-id");
  studio.commands.panels.open("panel-id");
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
  execute: ({ studio, transport }) => {
    useStudio(studio);
    void transport.read();
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
  setup(context: AgentFeedbackExtensionContext) {
    useStudio(context.studio);
    void context.transport.read();
  },
  toolbar: [toolbar],
  panels: [panel],
});

type DispatchLeak = Extract<keyof AgentFeedbackExtensionContext, "dispatch">;
// @ts-expect-error The public context cannot expose React.Dispatch.
const noDispatch: DispatchLeak = "dispatch";
void noDispatch;
