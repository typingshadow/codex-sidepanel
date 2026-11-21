ObjC.import("AppKit");

function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.activateIgnoringOtherApps(true);
  const panel = $.NSOpenPanel.openPanel;
  const attachment = argv[1] === "files" || argv[1] === "folders";
  panel.canChooseFiles = argv[1] === "files";
  panel.canChooseDirectories = argv[1] !== "files";
  panel.canCreateDirectories = !attachment;
  panel.allowsMultipleSelection = attachment;
  panel.title = attachment ? (argv[1] === "files" ? "选择图片或文件" : "选择文件夹") : "选择 Codex 工作目录";
  panel.prompt = attachment ? "添加引用" : "使用此文件夹";
  if (argv.length) panel.directoryURL = $.NSURL.fileURLWithPath(argv[0]);
  const selected = panel.runModal === $.NSModalResponseOK;
  if (!attachment) return selected ? ObjC.unwrap(panel.URL.path) : "";
  const paths = [];
  if (selected) {
    for (let i = 0; i < panel.URLs.count; i++) paths.push(ObjC.unwrap(panel.URLs.objectAtIndex(i).path));
  }
  return JSON.stringify(paths);
}
