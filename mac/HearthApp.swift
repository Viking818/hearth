// Hearth for Mac: starts Hearth's server (bundled Node.js and app files), shows the app in its own window,
// and keeps a menu bar icon with the model's state, memory use and quick actions. Closing the window keeps
// Hearth running for other apps; Quit stops the model and the server.
import Cocoa
import ServiceManagement
import WebKit

// MARK: - Words

struct Words {
  let ru: Bool
  init(language: String) {
    if language == "ru" { ru = true } else if language == "en" { ru = false } else {
      ru = Locale.preferredLanguages.first?.hasPrefix("ru") ?? false
    }
  }
  var open: String { ru ? "Открыть Hearth" : "Open Hearth" }
  var stopModel: String { ru ? "Остановить модель" : "Stop the model" }
  var loadLast: String { ru ? "Загрузить последнюю модель" : "Load the last model" }
  var loginItem: String { ru ? "Запускать при входе в систему" : "Open at login" }
  var quit: String { ru ? "Выйти из Hearth" : "Quit Hearth" }
  var settings: String { ru ? "Настройки…" : "Settings…" }
  var about: String { ru ? "О Hearth" : "About Hearth" }
  var hide: String { ru ? "Скрыть Hearth" : "Hide Hearth" }
  var starting: String { ru ? "Hearth запускается…" : "Hearth is starting…" }
  var noModel: String { ru ? "Модель не загружена" : "No model loaded" }
  var loading: String { ru ? "загружается" : "loading" }
  var running: String { ru ? "работает" : "running" }
  var generating: String { ru ? "пишет ответ" : "writing a reply" }
  var failed: String { ru ? "ошибка" : "error" }
  func memory(_ used: Double, _ total: Double) -> String {
    ru ? String(format: "Память: %.0f из %.0f ГБ", used, total) : String(format: "Memory: %.0f of %.0f GB", used, total)
  }
  var couldNotStart: String { ru ? "Hearth не запустился" : "Hearth could not start" }
  var loginFailed: String { ru ? "Не удалось включить запуск при входе" : "Could not turn on Open at login" }
  var loginHint: String {
    ru ? "Разрешите Hearth в Системных настройках → Основные → Объекты входа." : "Allow Hearth in System Settings → General → Login Items."
  }
  var edit: String { ru ? "Правка" : "Edit" }
  var undo: String { ru ? "Отменить" : "Undo" }
  var redo: String { ru ? "Повторить" : "Redo" }
  var cut: String { ru ? "Вырезать" : "Cut" }
  var copy: String { ru ? "Скопировать" : "Copy" }
  var paste: String { ru ? "Вставить" : "Paste" }
  var selectAll: String { ru ? "Выбрать все" : "Select All" }
  var view: String { ru ? "Вид" : "View" }
  var reload: String { ru ? "Обновить страницу" : "Reload Page" }
  var zoomIn: String { ru ? "Крупнее" : "Zoom In" }
  var zoomOut: String { ru ? "Мельче" : "Zoom Out" }
  var actualSize: String { ru ? "Обычный размер" : "Actual Size" }
  var windowMenu: String { ru ? "Окно" : "Window" }
  var minimize: String { ru ? "Свернуть" : "Minimize" }
  var close: String { ru ? "Закрыть окно" : "Close Window" }
  var newChat: String { ru ? "Новый чат" : "New Chat" }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var window: NSWindow?
  var web: WKWebView?
  var statusItem: NSStatusItem!
  var statusLine = NSMenuItem()
  var memoryLine = NSMenuItem()
  var modelAction = NSMenuItem()
  var loginAction = NSMenuItem()
  var server: Process?
  var ownServer = false
  var base = URL(string: "http://127.0.0.1:7420")!
  var popups: [NSWindow] = []
  var words = Words(language: "auto")
  var engine: [String: Any] = [:]
  var lastModel: [String: Any]?
  var quitting = false

  let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Hearth")
  let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Hearth")

  func applicationDidFinishLaunching(_ note: Notification) {
    let settings = readSettings()
    words = Words(language: settings["language"] as? String ?? "auto")
    if let port = settings["port"] as? Int { base = URL(string: "http://127.0.0.1:\(port)")! }
    buildMainMenu()
    buildStatusItem()
    NSApp.setActivationPolicy(.regular)
    startServer { [weak self] ok, detail in
      guard let self else { return }
      if ok {
        self.showWindow()
      } else {
        let alert = NSAlert()
        alert.messageText = self.words.couldNotStart
        alert.informativeText = detail
        alert.runModal()
        NSApp.terminate(nil)
      }
    }
  }

  func readSettings() -> [String: Any] {
    let file = support.appendingPathComponent("settings.json")
    guard let data = try? Data(contentsOf: file), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
  }

  // MARK: Server

  func ping(_ url: URL, done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: url.appendingPathComponent("api/ping"))
    req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let ok = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["app"] as? String == "hearth"
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  func startServer(done: @escaping (Bool, String) -> Void) {
    ping(base) { [weak self] running in
      guard let self else { return }
      if running { return done(true, "") } // started earlier from Terminal or another copy: just use it
      guard let res = Bundle.main.resourceURL else { return done(false, "No resources") }
      let node = res.appendingPathComponent("node")
      let app = res.appendingPathComponent("hearth")
      let p = Process()
      p.executableURL = node
      p.arguments = [app.appendingPathComponent("server/index.mjs").path]
      p.currentDirectoryURL = app
      var env = ProcessInfo.processInfo.environment
      env["HEARTH_APP"] = "mac"
      // Apps started from the Dock get a short PATH; add Homebrew's so tools like whisper.cpp and npx are found.
      env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
      p.environment = env
      try? FileManager.default.createDirectory(at: self.logs, withIntermediateDirectories: true)
      let logURL = self.logs.appendingPathComponent("hearth.log")
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
      let log = try? FileHandle(forWritingTo: logURL)
      let pipe = Pipe()
      p.standardOutput = pipe
      p.standardError = pipe
      var output = ""
      pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
        let d = h.availableData
        if d.isEmpty { return }
        log?.write(d)
        guard let s = String(data: d, encoding: .utf8) else { return }
        output += s
        // The server may move to the next free port; it prints the address it really uses.
        if let r = s.range(of: #"App:\s+(http://127\.0\.0\.1:\d+)"#, options: .regularExpression) {
          let line = String(s[r])
          if let u = line.components(separatedBy: CharacterSet.whitespaces).last, let url = URL(string: u) {
            DispatchQueue.main.async { self?.base = url }
          }
        }
      }
      p.terminationHandler = { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, !self.quitting else { return }
          self.server = nil
        }
      }
      do {
        try p.run()
      } catch {
        return done(false, error.localizedDescription)
      }
      self.server = p
      self.ownServer = true
      // Wait until it answers (big data folders can take a few seconds).
      var tries = 0
      func check() {
        tries += 1
        self.ping(self.base) { ok in
          if ok { return done(true, "") }
          if !p.isRunning || tries > 120 { return done(false, String(output.suffix(800))) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check() }
        }
      }
      check()
    }
  }

  func api(_ path: String, method: String = "GET", body: [String: Any]? = nil, done: (([String: Any]?) -> Void)? = nil) {
    var req = URLRequest(url: URL(string: path, relativeTo: base)!)
    req.httpMethod = method
    req.timeoutInterval = 4
    req.setValue(words.ru ? "ru" : "en", forHTTPHeaderField: "x-hearth-lang")
    if let body {
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
      req.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async { done?(obj) }
    }.resume()
  }

  // MARK: Window

  func showWindow() {
    if let w = window {
      w.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = []
    config.preferences.isElementFullscreenEnabled = true
    let wv = WKWebView(frame: .zero, configuration: config)
    wv.uiDelegate = self
    wv.navigationDelegate = self
    wv.allowsMagnification = true
    web = wv
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    w.title = "Hearth"
    w.titlebarAppearsTransparent = true
    w.minSize = NSSize(width: 760, height: 520)
    w.contentView = wv
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.center()
    w.setFrameAutosaveName("HearthMain")
    window = w
    wv.load(URLRequest(url: base))
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if sender === window {
      sender.orderOut(nil) // Hearth keeps running for other apps; the menu bar icon brings it back
      return false
    }
    popups.removeAll { $0 === sender }
    return true
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  // Links to other sites open in the normal browser; Hearth's own pages stay here.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme), url.host != base.host || url.port != base.port {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var url = folder.appendingPathComponent(suggestedFilename)
    let stem = url.deletingPathExtension().lastPathComponent
    let ext = url.pathExtension
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      url = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
      n += 1
    }
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    if let url = download.progress.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
  }

  // window.open: previews ("open in a new window") get a window of their own; other sites go to the browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, url.scheme == "http" || url.scheme == "https", url.host != base.host {
      NSWorkspace.shared.open(url)
      return nil
    }
    let wv = WKWebView(frame: .zero, configuration: configuration)
    wv.uiDelegate = self
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.contentView = wv
    w.title = "Hearth"
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.center()
    w.makeKeyAndOrderFront(nil)
    popups.append(w)
    return wv
  }

  func webViewDidClose(_ webView: WKWebView) {
    if let w = popups.first(where: { $0.contentView === webView }) { w.close() }
  }

  // The microphone, for voice input: only Hearth's own page may ask.
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(origin.host == "127.0.0.1" || origin.host == "localhost" ? .grant : .deny)
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: words.ru ? "Отмена" : "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  // MARK: Menu bar icon

  func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let img = NSImage(systemSymbolName: "flame", accessibilityDescription: "Hearth")
    img?.isTemplate = true
    statusItem.button?.image = img
    let menu = NSMenu()
    menu.delegate = self
    statusLine = NSMenuItem(title: words.starting, action: nil, keyEquivalent: "")
    statusLine.isEnabled = false
    memoryLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    memoryLine.isEnabled = false
    memoryLine.isHidden = true
    menu.addItem(statusLine)
    menu.addItem(memoryLine)
    menu.addItem(.separator())
    menu.addItem(withTitle: words.open, action: #selector(openApp), keyEquivalent: "o").target = self
    modelAction = NSMenuItem(title: words.stopModel, action: #selector(toggleModel), keyEquivalent: "")
    modelAction.target = self
    menu.addItem(modelAction)
    menu.addItem(.separator())
    loginAction = NSMenuItem(title: words.loginItem, action: #selector(toggleLogin), keyEquivalent: "")
    loginAction.target = self
    menu.addItem(loginAction)
    menu.addItem(.separator())
    menu.addItem(withTitle: words.quit, action: #selector(quitApp), keyEquivalent: "q").target = self
    statusItem.menu = menu
  }

  func menuWillOpen(_ menu: NSMenu) {
    loginAction.state = SMAppService.mainApp.status == .enabled ? .on : .off
    api("/api/status") { [weak self] st in
      guard let self, let st else { return }
      self.engine = st["engine"] as? [String: Any] ?? [:]
      self.lastModel = (st["settings"] as? [String: Any])?["lastModel"] as? [String: Any]
      let status = self.engine["status"] as? String ?? "stopped"
      let model = (self.engine["model"] as? [String: Any])?["name"] as? String
      switch status {
      case "ready": self.statusLine.title = "\(model ?? "") — \(self.words.running)"
      case "starting": self.statusLine.title = "\(model ?? "") — \(self.words.loading)"
      case "error": self.statusLine.title = "\(model ?? "") — \(self.words.failed)"
      default: self.statusLine.title = self.words.noModel
      }
      let active = status == "ready" || status == "starting"
      self.modelAction.title = active ? self.words.stopModel : self.words.loadLast
      self.modelAction.isHidden = !active && self.lastModel == nil
    }
    api("/api/monitor") { [weak self] snap in
      guard let self, let stats = snap?["stats"] as? [String: Any], let used = stats["ramUsed"] as? Double, let total = stats["ramTotal"] as? Double else { return }
      self.memoryLine.title = self.words.memory(used / 1_073_741_824, total / 1_073_741_824)
      self.memoryLine.isHidden = false
      if (snap?["live"] as? [String: Any])?["state"] as? String == "generating", let m = (self.engine["model"] as? [String: Any])?["name"] as? String {
        self.statusLine.title = "\(m) — \(self.words.generating)"
      }
    }
  }

  @objc func openApp() { showWindow() }

  @objc func toggleModel() {
    let status = engine["status"] as? String ?? "stopped"
    if status == "ready" || status == "starting" {
      api("/api/engine/stop", method: "POST")
    } else if let id = lastModel?["id"] as? String {
      api("/api/engine/start", method: "POST", body: ["id": id])
    }
  }

  @objc func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
    } catch {
      let a = NSAlert()
      a.messageText = words.loginFailed
      a.informativeText = "\(words.loginHint)\n\n\(error.localizedDescription)"
      a.runModal()
      SMAppService.openSystemSettingsLoginItems()
    }
  }

  @objc func quitApp() { NSApp.terminate(nil) }

  // Quit stops the server Hearth started (and with it the model); one started elsewhere keeps running.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard ownServer, let p = server, p.isRunning else { return .terminateNow }
    quitting = true
    api("/api/shutdown", method: "POST")
    DispatchQueue.global().async {
      for _ in 0..<60 where p.isRunning { usleep(100_000) }
      if p.isRunning { p.terminate() }
      DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  // MARK: Main menu (Edit is needed for copy and paste in the page)

  func buildMainMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: words.about, action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: words.settings, action: #selector(openSettings), keyEquivalent: ",").target = self
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: words.hide, action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: words.quit, action: #selector(quitApp), keyEquivalent: "q").target = self
    appItem.submenu = appMenu
    main.addItem(appItem)

    let fileItem = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    fileMenu.addItem(withTitle: words.newChat, action: #selector(newChat), keyEquivalent: "n").target = self
    fileItem.submenu = fileMenu
    main.addItem(fileItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: words.edit)
    edit.addItem(withTitle: words.undo, action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: words.redo, action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: words.cut, action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: words.copy, action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: words.paste, action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: words.selectAll, action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: words.view)
    view.addItem(withTitle: words.reload, action: #selector(reloadPage), keyEquivalent: "r").target = self
    view.addItem(.separator())
    view.addItem(withTitle: words.zoomIn, action: #selector(zoomIn), keyEquivalent: "+").target = self
    view.addItem(withTitle: words.zoomOut, action: #selector(zoomOut), keyEquivalent: "-").target = self
    view.addItem(withTitle: words.actualSize, action: #selector(zoomReset), keyEquivalent: "0").target = self
    viewItem.submenu = view
    main.addItem(viewItem)

    let winItem = NSMenuItem()
    let win = NSMenu(title: words.windowMenu)
    win.addItem(withTitle: words.minimize, action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: words.close, action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = win
    main.addItem(winItem)
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }

  @objc func openSettings() {
    showWindow()
    web?.evaluateJavaScript("location.hash = '#/settings'")
  }

  @objc func newChat() {
    showWindow()
    web?.evaluateJavaScript("location.hash = '#/'")
  }

  @objc func reloadPage() { web?.reload() }
  @objc func zoomIn() { web?.pageZoom = min(2, (web?.pageZoom ?? 1) + 0.1) }
  @objc func zoomOut() { web?.pageZoom = max(0.6, (web?.pageZoom ?? 1) - 0.1) }
  @objc func zoomReset() { web?.pageZoom = 1 }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
