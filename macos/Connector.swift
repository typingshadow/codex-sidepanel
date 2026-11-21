import Foundation
import CryptoKit
import ImageIO

let input = FileHandle.standardInput
let output = FileHandle.standardOutput
let outputLock = NSLock()
let commandLock = NSLock()
let manager = FileManager.default
let home = manager.homeDirectoryForCurrentUser
let hostName = "local.codex_sidepanel"
let connectorVersion = "3.0"

struct ConnectorPolicy: Decodable {
    let clientName: String
    let instructions: String
    let readTurn: String
    let writeTurn: String
    let appServerConfigOverrides: [String]
}

struct RequestError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

func rejection(_ id: Any, _ message: String) -> [String: Any] {
    ["id": id, "error": ["code": -32602, "message": message]]
}

let workspaceRegistry = home.appendingPathComponent("Library/Application Support/Codex Browser Connector/Workspaces")

func workspaceRecord(_ directory: String) -> URL {
    let key = SHA256.hash(data: Data(directory.utf8)).map { String(format: "%02x", $0) }.joined()
    return workspaceRegistry.appendingPathComponent(key + ".json")
}

func availableWorkspaces(_ workspace: URL) -> [String] {
    let files = (try? manager.contentsOfDirectory(at: workspaceRegistry, includingPropertiesForKeys: nil)) ?? []
    let approved = files.compactMap { file -> String? in
        guard file.pathExtension == "json",
              let data = try? Data(contentsOf: file),
              let path = try? JSONDecoder().decode(String.self, from: data),
              path.hasPrefix("/"),
              (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
        return path
    }
    return Array(Set(approved + [workspace.path])).sorted()
}

func pickerOutput(_ workspace: URL, script: URL, mode: String? = nil) throws -> Data {
    let picker = Process()
    let result = Pipe()
    picker.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    picker.arguments = ["-l", "JavaScript", script.path, workspace.path] + (mode.map { [$0] } ?? [])
    picker.standardOutput = result
    try picker.run()
    let timeout = DispatchWorkItem {
        if picker.isRunning { picker.terminate() }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: timeout)
    defer { timeout.cancel() }
    let data = result.fileHandleForReading.readDataToEndOfFile()
    picker.waitUntilExit()
    guard picker.terminationStatus == 0 else { throw RequestError("无法打开文件夹选择器。") }
    return data
}

func pickWorkspace(_ workspace: URL, script: URL) throws -> String? {
    var directory = String(decoding: try pickerOutput(workspace, script: script), as: UTF8.self)
    if directory.hasSuffix("\n") { directory.removeLast() }
    guard !directory.isEmpty else { return nil }
    let selected = URL(fileURLWithPath: directory).resolvingSymlinksInPath()
    guard try selected.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
        throw RequestError("请选择文件夹。")
    }
    try manager.createDirectory(at: workspaceRegistry, withIntermediateDirectories: true)
    try JSONEncoder().encode(selected.path).write(to: workspaceRecord(selected.path), options: .atomic)
    return selected.path
}

func isFeishuPage(_ page: String) -> Bool {
    guard let url = URLComponents(string: page),
          url.scheme == "https", let host = url.host, url.user == nil, url.password == nil,
          url.port == nil, url.query == nil, url.fragment == nil,
          ["feishu.cn", "larksuite.com", "doubao.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) })
    else { return false }
    return url.percentEncodedPath.range(of: #"^/(docx|wiki|base|sheets|sheet)/[a-zA-Z0-9]+/?$"#,
                                        options: .regularExpression) != nil
}

func isFeishuDocument(_ page: String) -> Bool {
    guard isFeishuPage(page), let path = URLComponents(string: page)?.path else { return false }
    return path.hasPrefix("/docx/") || path.hasPrefix("/wiki/")
}

func requestParams(_ method: String, _ params: [String: Any], workspace: URL,
                   allowed: [String: String], policy: ConnectorPolicy) throws -> [String: Any] {
    switch method {
    case "initialize": return ["capabilities": ["experimentalApi": true], "clientInfo": ["name": policy.clientName, "version": connectorVersion]]
    case "initialized": return [:]
    case "account/read": return ["refreshToken": false]
    case "thread/list":
        return ["archived": params["archived"] as? Bool ?? false, "currentAccountOnly": true, "limit": 40,
                "sortKey": "updated_at", "cursor": params["cursor"] ?? NSNull()]
    case "thread/start":
        let directory = params["workspace"] as? String ?? workspace.path
        guard availableWorkspaces(workspace).contains(directory) else { throw RequestError("此工作目录不可用，请重新选择文件夹。") }
        return ["cwd": directory, "sandbox": "workspace-write", "approvalPolicy": "never",
                "developerInstructions": policy.instructions]
    default: break
    }
    guard let id = params["threadId"] as? String, let threadDirectory = allowed[id] else {
        throw RequestError("此会话不在当前账号的侧栏历史中，请重新打开历史菜单。")
    }
    switch method {
    case "thread/resume":
        guard availableWorkspaces(workspace).contains(threadDirectory) else { throw RequestError("请先重新选择这段会话原来的工作目录。") }
        return ["threadId": id, "cwd": threadDirectory, "sandbox": "workspace-write",
                "approvalPolicy": "never", "developerInstructions": policy.instructions, "excludeTurns": true]
    case "thread/turns/list":
        return ["threadId": id, "cursor": params["cursor"] ?? NSNull(), "limit": 4,
                "sortDirection": "desc", "itemsView": "summary"]
    case "thread/archive", "thread/unarchive": return ["threadId": id]
    case "turn/interrupt": return ["threadId": id, "turnId": params["turnId"] ?? NSNull()]
    case "turn/start":
        guard availableWorkspaces(workspace).contains(threadDirectory) else {
            throw RequestError("此工作目录已移除或不可用，请重新选择。")
        }
        guard let text = params["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= 16000, let effort = params["effort"] as? String,
              ["low", "medium", "high"].contains(effort) else {
            throw RequestError("请求格式无效，或消息太长。")
        }
        let focus = params["writeTarget"] as? String
        let targets: [String]
        if let supplied = params["writeTargets"], !(supplied is NSNull) {
            guard let array = supplied as? [String], array.count <= 100 else {
                throw RequestError("工作区页面列表无效。")
            }
            targets = array
        } else {
            targets = focus.map { [$0] } ?? []
        }
        if let focus, !targets.contains(focus) {
            throw RequestError("聚焦页面不在本次工作区中。")
        }
        for page in targets {
            guard isFeishuPage(page) else {
                throw RequestError("工作区中存在无效的飞书页面链接。")
            }
        }
        var mode = policy.readTurn
        if !targets.isEmpty {
            var seen = Set<String>()
            let unique = targets.filter { seen.insert($0).inserted }
            mode = policy.writeTurn + (focus ?? "未选择；按用户指令确定目标") +
                "\n本次可读写的工作区页面：\n" + unique.joined(separator: "\n")
        }
        return ["threadId": id, "effort": effort, "input": [
            ["type": "text", "text": mode + "\n\n用户请求：\n" + text, "text_elements": []]
        ]]
    default: throw RequestError("连接器不支持该请求。")
    }
}

private func userRequestText(_ text: String, policy: ConnectorPolicy) -> String {
    guard text.hasPrefix(policy.readTurn) || text.hasPrefix(policy.writeTurn) ||
          text.hasPrefix("Active Feishu document for this turn.") ||
          text.hasPrefix("Connector mode for this turn: the user enabled editing for this document only: "),
          let range = text.range(of: "\n\n用户请求：\n") else { return text }
    return String(text[range.upperBound...])
}

func filteredResponse(_ packet: [String: Any], method: String,
                      allowed: inout [String: String], policy: ConnectorPolicy) -> [String: Any] {
    guard let result = packet["result"] as? [String: Any] else { return packet }
    var response = packet
    switch method {
    case "account/read":
        allowed.removeAll()
        response["result"] = ["authenticated": result["account"] is [String: Any],
                              "requiresOpenaiAuth": result["requiresOpenaiAuth"] ?? true]
    case "thread/list":
        let data = (result["data"] as? [[String: Any]] ?? []).filter { ($0["originator"] as? String) == policy.clientName }
        for entry in data {
            if let id = entry["id"] as? String { allowed[id] = entry["cwd"] as? String ?? "" }
        }
        let entries = data.map { thread -> [String: Any] in
            var entry = thread.filter { ["id", "name", "preview", "cwd"].contains($0.key) }
            if let preview = entry["preview"] as? String { entry["preview"] = userRequestText(preview, policy: policy) }
            return entry
        }
        response["result"] = ["data": entries,
                              "nextCursor": result["nextCursor"] ?? NSNull()]
    case "thread/start", "thread/resume":
        if let id = (result["thread"] as? [String: Any])?["id"] as? String {
            allowed[id] = result["cwd"] as? String ?? (result["thread"] as? [String: Any])?["cwd"] as? String ?? ""
            response["result"] = ["thread": ["id": id]]
        }
    case "thread/turns/list":
        let data = result["data"] as? [[String: Any]] ?? []
        let turns = data.map { turn in
            ["items": (turn["items"] as? [[String: Any]] ?? [])
                .filter { ["userMessage", "agentMessage"].contains($0["type"] as? String ?? "") }
                .map { item -> [String: Any] in
                    if item["type"] as? String == "agentMessage" {
                        return ["type": "agentMessage", "text": item["text"] ?? ""]
                    }
                    let content = (item["content"] as? [[String: Any]] ?? []).compactMap { part -> [String: String]? in
                        guard part["type"] as? String == "text", let body = part["text"] as? String else { return nil }
                        let text = userRequestText(body, policy: policy)
                        if text.hasPrefix(attachmentMarker + "\n") {
                            var seen = Set<String>()
                            let names = text.split(separator: "\n").dropFirst().compactMap { line -> String? in
                                guard let name = line.components(separatedBy: " | ").first,
                                      let label = name.split(separator: "/").first.map(String.init),
                                      seen.insert(label).inserted else { return nil }
                                return label
                            }
                            return ["type": "attachments", "text": names.joined(separator: "、")]
                        }
                        return ["type": "text", "text": text]
                    }
                    return ["type": "userMessage", "content": content]
                }]
        }
        response["result"] = ["data": turns, "nextCursor": result["nextCursor"] ?? NSNull()]
    default: break
    }
    return response
}

// The model can select only a document supplied by the panel for this exact turn.
let docTool: [String: Any] = [
    "name": "sidepanel_document",
    "description": "Use the installed official lark-cli for a supplied Feishu docx/wiki document. Read, append plain text, or replace a literal phrase. Read back edits.",
    "inputSchema": ["type": "object", "additionalProperties": false,
        "properties": ["document": ["type": "string"], "operation": ["type": "string", "enum": ["read","append","replace"]],
                       "text": ["type":"string"], "oldText": ["type":"string"]],
        "required": ["document","operation"]]
]

func runDocumentTool(_ args: [String: Any], documents: Set<String>, cli: URL, env: [String:String], checkOnly: Bool = false, stillAllowed: () -> Bool) throws -> String {
    guard let doc = args["document"] as? String, documents.contains(doc),
          isFeishuDocument(doc),
          let op = args["operation"] as? String else { throw RequestError("目标不在本轮文档列表中。") }
    let task = Process()
    task.executableURL = cli
    task.environment = env
    task.currentDirectoryURL = home
    var flags = ["docs", "+fetch", "--as", "user", "--doc", doc, "--doc-format", "markdown"]
    if checkOnly { flags += ["--scope", "outline", "--max-depth", "1"] }
    if op != "read" {
        guard ["append","replace"].contains(op), let text = args["text"] as? String,
              !text.isEmpty, text.utf8.count <= 16000 else { throw RequestError("只支持追加或替换非空纯文字。") }
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        flags = ["docs", "+update", "--as","user","--doc",doc,"--doc-format","xml",
                 "--command",op == "append" ? "append" : "str_replace","--content",op == "append" ? "<p>" + escaped + "</p>" : escaped]
        guard !escaped.hasPrefix("@"), escaped != "-" else { throw RequestError("此文字格式不受支持。") }
        if op == "replace" {
            guard let old = args["oldText"] as? String, !old.isEmpty, old.utf8.count <= 4000,
                  !old.hasPrefix("@"), old != "-" else { throw RequestError("请指定待替换的原文。") }
            flags += ["--pattern",old]
        }
    }
    let pipe = Pipe()
    task.arguments = flags
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = pipe
    task.standardError = pipe
    guard stillAllowed() else { throw RequestError("本轮请求已经结束。") }
    try task.run()
    let timeout = DispatchWorkItem { if task.isRunning { task.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(checkOnly ? 20 : 60), execute: timeout)
    defer { timeout.cancel() }
    var data = Data()
    while let chunk = try pipe.fileHandleForReading.read(upToCount: 16384), !chunk.isEmpty {
        if data.count + chunk.count > 512000 {
            task.terminate()
            throw RequestError("文档输出超出读取上限。")
        }
        data.append(chunk)
    }
    task.waitUntilExit()
    let result = decode(data)
    if task.terminationReason == .uncaughtSignal {
        throw RequestError("飞书 CLI 调用中断或超时。若 Mac 正在等待钥匙串授权，请确认弹窗，再重试读取。")
    }
    if task.terminationStatus != 0 || result?["ok"] as? Bool == false {
        throw RequestError(documentFailure(data, exitCode: task.terminationStatus))
    }
    if checkOnly, result?["ok"] as? Bool != true {
        throw RequestError("飞书 CLI 未返回可验证的读取结果。请在系统终端用同一个 CLI 复测。")
    }
    return String(decoding: data, as: UTF8.self)
}

// CLI output can include document content or credentials. Return fixed guidance and numeric codes only.
func documentStats(_ output: String) throws -> [String: Int] {
    guard let result = decode(Data(output.utf8)),
          let data = result["data"] as? [String: Any],
          let document = data["document"] as? [String: Any],
          let markdown = document["content"] as? String else {
        throw RequestError("飞书未返回可统计的文档正文。")
    }
    let imagePattern = #"!\[([^\]]*)\]\([^)]*\)"#
    let images = try NSRegularExpression(pattern: imagePattern)
    let range = NSRange(markdown.startIndex..., in: markdown)
    let body = markdown
        .replacingOccurrences(of: imagePattern, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)|<[^>]*>"#, with: "$1", options: .regularExpression)
    let han = try NSRegularExpression(pattern: #"\p{Han}"#)
    return ["han": han.numberOfMatches(in: body, range: NSRange(body.startIndex..., in: body)),
            "images": images.numberOfMatches(in: markdown, range: range)]
}

func documentFailure(_ data: Data, exitCode: Int32) -> String {
    let raw = String(decoding: data, as: UTF8.self).lowercased()
    let detail = decode(data)?["error"] as? [String: Any]
    let code = (detail?["code"] as? Int).map { "，飞书错误码 \($0)" } ?? ""
    let status = "（退出码 \(exitCode)\(code)）"
    if raw.contains("keychain") || raw.contains("钥匙串") || raw.contains("dpop") ||
        raw.contains("-25308") || raw.contains("-25293") || raw.contains("-25300") {
        return "飞书 CLI 无法完成本机签名" + status + "。请确认 Mac 已解锁，并查看是否有钥匙串授权弹窗。若仍失败，在系统终端用同一个 CLI 复测。"
    }
    if raw.contains("missing_scopes") || raw.contains("insufficient_scope") {
        return "飞书 CLI 缺少文档读取或写入授权" + status + "。请用现有飞书账号补齐所需授权。"
    }
    if raw.contains("invalid_grant") || raw.contains("invalid_token") ||
        raw.contains("not logged in") || raw.contains("token expired") ||
        raw.contains("auth login") || raw.contains("未登录") {
        return "飞书 CLI 登录或用户授权需要确认" + status + "。请在系统终端用现有飞书账号检查 CLI 授权。"
    }
    if raw.contains("permission denied") || raw.contains("access denied") ||
        raw.contains("forbidden") || raw.contains("无权限") {
        return "飞书 CLI 报告访问被拒绝" + status + "。请核对 CLI 登录的账号及当前文档权限。"
    }
    if raw.contains("timeout") || raw.contains("connection refused") || raw.contains("dial tcp") {
        return "飞书 CLI 连接失败" + status + "。请检查网络，再重新检查飞书连接。"
    }
    return "飞书 CLI 调用失败" + status + "。可在系统终端用同一个 CLI 复测并查看原始错误。"
}

final class BridgeState {
    var submittedDocs = [Int: (String,Set<String>)]()
    var turnDocs = [String: (String,Set<String>)]()
    let docSlot = DispatchSemaphore(value: 1)
    let lock = NSLock()
    var allowed = [String: String]()
    var pending = [Int: String]()
    var accountChecked = false
    let pickerSlot = DispatchSemaphore(value: 1)
}

func send(_ packet: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: packet) else { return }
    if data.count > 1_048_576 {
        let message = "回复过长，无法传回侧栏。"
        let failure = packet["id"].map { rejection($0, message) } ?? ["bridgeError": message]
        guard let fallback = try? JSONSerialization.data(withJSONObject: failure) else { return }
        data = fallback
    }
    var size = UInt32(data.count).littleEndian
    outputLock.lock()
    defer { outputLock.unlock() }
    try? output.write(contentsOf: withUnsafeBytes(of: &size) { Data($0) } + data)
}

func readExactly(_ count: Int, from handle: FileHandle) throws -> Data? {
    var bytes = Data()
    while bytes.count < count {
        guard let chunk = try handle.read(upToCount: count - bytes.count), !chunk.isEmpty else { return nil }
        bytes.append(chunk)
    }
    return bytes
}

func decode(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private let attachmentLimit = 8 * 1024 * 1024
private let attachmentMarker = "[Codex Sidepanel attachment paths]"
private let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "webp", "gif"]
private let documentExtensions: Set<String> = ["pdf", "docx", "xlsx", "pptx", "csv", "tsv", "txt", "md"]

private struct IncomingAttachment {
    let name: String
    let size: Int
    let isImage: Bool
    let folder: UUID?
    var data = Data()
}

private struct AttachmentBatch {
    let thread: String
    var files: [IncomingAttachment]
    var updated = Date()
}

private final class LocalReferences {
    private struct Selection {
        let url: URL
        let isDirectory: Bool
        let created = Date()
    }

    private let lock = NSLock()
    private var selections: [UUID: Selection] = [:]

    private func preview(for entry: Selection) -> String? {
        guard !entry.isDirectory, imageExtensions.contains(entry.url.pathExtension.lowercased()),
              let source = CGImageSourceCreateWithURL(entry.url as CFURL, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 80,
              ] as CFDictionary),
              let bytes = CFDataCreateMutable(nil, 0),
              let destination = CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, thumbnail, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return "data:image/png;base64," + (bytes as Data).base64EncodedString()
    }

    func pick(_ workspace: URL, script: URL, mode: String) throws -> [[String: Any]] {
        let data = try pickerOutput(workspace, script: script, mode: mode)
        let paths = try JSONDecoder().decode([String].self, from: data)
        guard paths.count <= 5 else { throw RequestError("一次最多选择 5 项附件。") }
        let picked = try paths.map { path -> Selection in
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
            let directory = mode == "folders"
            guard directory ? values.isDirectory == true : values.isRegularFile == true else {
                throw RequestError("请选择普通文件或文件夹。")
            }
            return Selection(url: url, isDirectory: directory)
        }
        let previews = picked.map(preview)
        lock.lock()
        defer { lock.unlock() }
        selections = selections.filter { $0.value.created > Date().addingTimeInterval(-43200) }
        guard selections.count + picked.count <= 500 else { throw RequestError("附件引用过多，请重新连接后再试。") }
        return zip(picked, previews).map { entry, preview in
            let token = UUID()
            selections[token] = entry
            var result: [String: Any] = ["token": token.uuidString, "name": entry.url.lastPathComponent,
                                         "directory": entry.isDirectory]
            if let preview { result["preview"] = preview }
            return result
        }
    }

    func discard(_ tokens: [String]) {
        lock.lock()
        defer { lock.unlock() }
        for token in tokens.prefix(5).compactMap(UUID.init) { selections.removeValue(forKey: token) }
    }

    func inputs(for tokens: [String]) throws -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        guard (1...5).contains(tokens.count), Set(tokens).count == tokens.count else {
            throw RequestError("本地附件引用无效。")
        }
        var listing = attachmentMarker
        var inputs: [[String: Any]] = []
        for raw in tokens {
            guard let token = UUID(uuidString: raw), let entry = selections[token],
                  Date().timeIntervalSince(entry.created) < 43200 else {
                throw RequestError("本地附件引用已失效，请重新选择。")
            }
            let values = try entry.url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
            guard manager.isReadableFile(atPath: entry.url.path),
                  entry.isDirectory ? values.isDirectory == true : values.isRegularFile == true else {
                throw RequestError("无法读取本地附件，请重新选择。")
            }
            let label = entry.url.lastPathComponent.components(separatedBy: .newlines).joined(separator: " ")
                .replacingOccurrences(of: " | ", with: " ")
            // JSON escaping keeps paths with newlines and quotes on one line.
            let encoder = JSONEncoder()
            encoder.outputFormatting = .withoutEscapingSlashes
            let encodedPath = try encoder.encode(entry.url.path)
            listing += "\n" + label + " | " + String(decoding: encodedPath, as: UTF8.self)
            if !entry.isDirectory, imageExtensions.contains(entry.url.pathExtension.lowercased()),
               let image = CGImageSourceCreateWithURL(entry.url as CFURL, nil),
               let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
               let width = properties[kCGImagePropertyPixelWidth] as? Double,
               let height = properties[kCGImagePropertyPixelHeight] as? Double,
               width > 0, height > 0, width * height <= 40_000_000 {
                inputs.append(["type": "localImage", "path": entry.url.path])
            }
        }
        inputs.append(["type": "text", "text": listing, "text_elements": []])
        return inputs
    }
}

private final class Attachments {
    private var batches: [String: AttachmentBatch] = [:]
    private let root = home.appendingPathComponent("Library/Caches/Codex Browser Connector/Attachments", isDirectory: true)

    init() {
        let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .creationDateKey]
        guard let directories = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys)) else { return }
        for directory in directories {
            guard UUID(uuidString: directory.lastPathComponent) != nil,
                  let values = try? directory.resourceValues(forKeys: keys),
                  values.isDirectory == true, values.isSymbolicLink == false,
                  let created = values.creationDate, created < cutoff else { continue }
            try? manager.removeItem(at: directory)
        }
    }

    func handle(_ method: String, _ params: [String: Any], allowed: [String: String]) throws {
        let cutoff = Date().addingTimeInterval(-600)
        batches = batches.filter { $0.value.updated > cutoff }
        guard let token = params["batch"] as? String, UUID(uuidString: token) != nil else {
            throw RequestError("附件批次无效。")
        }
        switch method {
        case "attachments/begin":
            guard let thread = params["threadId"] as? String, allowed[thread] != nil,
                  let files = params["files"] as? [[String: Any]], (1...30).contains(files.count),
                  batches[token] == nil, batches.count < 4 else {
                throw RequestError("附件批次无效或同时传输的附件过多。")
            }
            var total = 0
            let entries = try files.map { file -> IncomingAttachment in
                guard let original = file["name"] as? String, !original.isEmpty, original.utf8.count <= 1024,
                      let size = file["size"] as? Int, size > 0, size <= attachmentLimit else {
                    throw RequestError("附件名称或大小无效。")
                }
                total += size
                guard total <= attachmentLimit else { throw RequestError("每条消息的附件合计最多 8 MB。") }
                let ext = (original as NSString).pathExtension.lowercased()
                guard imageExtensions.contains(ext) || documentExtensions.contains(ext) else {
                    throw RequestError("附件格式不支持。")
                }
                let stem = (original as NSString).deletingPathExtension
                let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:|"))
                let safe = stem.unicodeScalars.map { forbidden.contains($0) ? "_" : String($0) }.joined()
                let name = String(safe.unicodeScalars.prefix(45)) + "." + ext
                if let relative = file["relativePath"] as? String {
                    let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
                    guard let folder = (file["folder"] as? String).flatMap(UUID.init),
                          (2...24).contains(parts.count), relative.utf8.count <= 1024,
                          parts.last == Substring(original),
                          parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 &&
                              String($0).rangeOfCharacter(from: forbidden.subtracting(CharacterSet(charactersIn: "/"))) == nil }) else {
                        throw RequestError("文件夹中有无法保留的文件路径。")
                    }
                    return IncomingAttachment(name: relative, size: size, isImage: false, folder: folder)
                }
                return IncomingAttachment(name: name, size: size, isImage: imageExtensions.contains(ext), folder: nil)
            }
            batches[token] = AttachmentBatch(thread: thread, files: entries)
        case "attachments/chunk":
            guard let index = params["index"] as? Int, let offset = params["offset"] as? Int,
                  let encoded = params["data"] as? String, encoded.utf8.count <= 174764,
                  let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 128 * 1024,
                  let batch = batches[token], batch.files.indices.contains(index),
                  offset == batch.files[index].data.count, data.count <= batch.files[index].size - offset else {
                throw RequestError("附件分块无效，请重新发送。")
            }
            batches[token]?.files[index].data.append(data)
            batches[token]?.updated = Date()
        case "attachments/discard":
            batches.removeValue(forKey: token)
        default:
            throw RequestError("连接器不支持该附件请求。")
        }
    }

    func inputs(for token: String, thread: String) throws -> [[String: Any]] {
        guard let batch = batches[token], batch.thread == thread,
              batch.files.allSatisfy({ $0.data.count == $0.size }) else {
            throw RequestError("附件尚未传完或会话已切换，请重新发送。")
        }
        batches.removeValue(forKey: token)
        for file in batch.files where file.isImage {
            guard let image = CGImageSourceCreateWithData(file.data as CFData, nil),
                  let type = CGImageSourceGetType(image) as String?,
                  ["public.png", "public.jpeg", "org.webmproject.webp", "com.compuserve.gif"].contains(type),
                  let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Double,
                  let height = properties[kCGImagePropertyPixelHeight] as? Double,
                  width > 0, height > 0, width * height <= 40_000_000 else {
                throw RequestError("图片无法识别或像素过大：" + file.name)
            }
        }
        try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            var inputs: [[String: Any]] = []
            var listing = attachmentMarker
            for (index, file) in batch.files.enumerated() {
                let path: URL
                if let folder = file.folder {
                    path = directory.appendingPathComponent(folder.uuidString, isDirectory: true)
                        .appendingPathComponent(file.name)
                    try manager.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
                } else {
                    path = directory.appendingPathComponent("\(index + 1)-" + file.name)
                }
                try file.data.write(to: path, options: .withoutOverwriting)
                listing += "\n" + file.name
                if file.isImage {
                    inputs.append(["type": "localImage", "path": path.path])
                } else {
                    listing += " | " + path.path
                }
            }
            inputs.append(["type": "text", "text": listing, "text_elements": []])
            return inputs
        } catch {
            try? manager.removeItem(at: directory)
            throw RequestError("本机连接器无法保存附件，请检查磁盘空间后重试。")
        }
    }
}

func run() throws {
    let policyPath = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        .appendingPathComponent("bridge-policy.json")
    let policy = try JSONDecoder().decode(ConnectorPolicy.self, from: Data(contentsOf: policyPath))
    let state = BridgeState()
    let attachments = Attachments()
    let localReferences = LocalReferences()
    let environment = ProcessInfo.processInfo.environment
    let commonBins = [".local/bin", ".npm-global/bin", "bin"].map { home.appendingPathComponent($0).path }
        + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    let appBin = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"
    let inheritedBins = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { $0.hasPrefix("/") }
    let paths = commonBins + inheritedBins + [appBin]
    func find(_ name: String) -> URL? {
        paths.lazy.map { URL(fileURLWithPath: $0).appendingPathComponent(name) }
            .first { manager.isExecutableFile(atPath: $0.path) }
    }

    let dedicatedLark = find("codex-lark-cli")
    let lark = dedicatedLark ?? find("lark-cli")
    send(["bridgeInfo": ["larkCli": lark != nil, "larkCheck": true, "documentStats": true, "connectorVersion": connectorVersion, "protocol": 3, "workspaces": true, "workspaceManagement": true, "groupEditing": true, "attachments": true, "folderAttachments": true, "localReferences": true, "threadArchive": true]])
    guard let codex = find("codex") else {
        send(["bridgeError": "找不到本机 Codex。安装 Codex 后，回到侧栏重新检查。"])
        return
    }

    let workspace = home.appendingPathComponent("Library/Application Support/Codex Browser Connector/Workspace")
    try manager.createDirectory(at: workspace, withIntermediateDirectories: true)
    let process = Process()
    process.executableURL = codex
    process.currentDirectoryURL = workspace
    var env = environment
    // A browser launched from the Codex desktop can inherit its originator.
    // Let the initialize request identify these threads as sidepanel threads.
    env.removeValue(forKey: "CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
    env["PATH"] = paths.joined(separator: ":")
    process.environment = env
    process.arguments = ["app-server", "--listen", "stdio://", "-c", "sandbox_workspace_write.network_access=true"]
    process.arguments! += policy.appServerConfigOverrides.flatMap { ["-c", $0] }
    if lark != nil {
        let larkStorage = dedicatedLark == nil
            ? ["Library/Application Support/lark-cli", ".lark-cli/locks"]
            : ["Library/Application Support/Codex Lark CLI/config", "Library/Application Support/lark-cli"]
        let writable = larkStorage.map { home.appendingPathComponent($0).path }
        let json = try JSONSerialization.data(withJSONObject: writable, options: [.withoutEscapingSlashes])
        process.arguments! += ["-c", "sandbox_workspace_write.writable_roots=" + String(decoding: json, as: UTF8.self)]
    }

    let requests = Pipe()
    let responses = Pipe()
    process.standardInput = requests
    process.standardOutput = responses
    process.standardError = FileHandle.standardError
    try process.run()
    let requestHandle = requests.fileHandleForWriting
    let responseHandle = responses.fileHandleForReading
    let events: Set<String> = ["item/started", "item/agentMessage/delta", "item/completed", "turn/completed"]
    let itemTypes: Set<String> = ["commandExecution", "dynamicToolCall", "mcpToolCall", "webSearch", "fileChange", "agentMessage"]

    func forward(_ packet: [String: Any]) throws {
        let json = try JSONSerialization.data(withJSONObject: packet)
        commandLock.lock()
        defer { commandLock.unlock() }
        try requestHandle.write(contentsOf: json + Data([10]))
    }

    DispatchQueue.global().async {
        defer {
            try? requestHandle.close()
            if process.isRunning { process.terminate() }
        }
        do {
            while let header = try readExactly(4, from: input) {
                let length = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
                guard length > 0, length <= 256 * 1024,
                      let data = try readExactly(length, from: input) else { return }
                guard let packet = decode(data), let method = packet["method"] as? String else { continue }
                let id = packet["id"] as? Int
                do {
                    if method == "attachments/pick", let id {
                        let params = packet["params"] as? [String: Any]
                        guard let mode = params?["mode"] as? String, ["files", "folders"].contains(mode) else {
                            throw RequestError("选择器类型无效。")
                        }
                        guard state.pickerSlot.wait(timeout: .now()) == .success else {
                            throw RequestError("已有选择器打开。")
                        }
                        let script = policyPath.deletingLastPathComponent().appendingPathComponent("workspace-picker.js")
                        DispatchQueue.global().async {
                            defer { state.pickerSlot.signal() }
                            do {
                                let picked = try localReferences.pick(workspace, script: script, mode: mode)
                                send(["id": id, "result": ["entries": picked]])
                            } catch {
                                send(rejection(id, error.localizedDescription))
                            }
                        }
                        continue
                    }
                    if method == "attachments/release", let id {
                        let params = packet["params"] as? [String: Any]
                        localReferences.discard(params?["tokens"] as? [String] ?? [])
                        send(["id": id, "result": [:] as [String: Any]])
                        continue
                    }
                    if method.hasPrefix("attachments/"), let id {
                        state.lock.lock()
                        let allowed = state.allowed
                        state.lock.unlock()
                        try attachments.handle(method, packet["params"] as? [String: Any] ?? [:], allowed: allowed)
                        send(["id": id, "result": [:] as [String: Any]])
                        continue
                    }
                    if ["feishu/check", "feishu/documentStats"].contains(method), let id {
                        let checkOnly = method == "feishu/check"
                        let params = packet["params"] as? [String: Any]
                        guard let doc = params?["document"] as? String, isFeishuDocument(doc) else {
                            throw RequestError("请打开要检查的飞书文档，再重试。")
                        }
                        guard let lark else { throw RequestError("连接器找不到本机飞书 CLI。请先安装并配置飞书 CLI。") }
                        guard state.docSlot.wait(timeout: .now()) == .success else {
                            throw RequestError("已有文档操作正在执行，请稍后重试。")
                        }
                        let checkEnvironment = env
                        DispatchQueue.global().async {
                            defer { state.docSlot.signal() }
                            do {
                                let output = try runDocumentTool(["document": doc, "operation": "read"],
                                                       documents: [doc], cli: lark, env: checkEnvironment,
                                                       checkOnly: checkOnly) { true }
                                if checkOnly {
                                    send(["id": id, "result": ["readable": true]])
                                } else {
                                    send(["id": id, "result": try documentStats(output)])
                                }
                            } catch {
                                send(rejection(id, error.localizedDescription))
                            }
                        }
                        continue
                    }
                    if method == "workspace/pick", let id {
                        guard state.pickerSlot.wait(timeout: .now()) == .success else {
                            send(rejection(id, "已有文件夹选择器打开。"))
                            continue
                        }
                        let script = policyPath.deletingLastPathComponent().appendingPathComponent("workspace-picker.js")
                        DispatchQueue.global().async {
                            defer { state.pickerSlot.signal() }
                            do {
                                let selected = try pickWorkspace(workspace, script: script)
                                send(["id": id, "result": ["default": workspace.path,
                                     "paths": availableWorkspaces(workspace), "selected": selected as Any? ?? NSNull()]])
                            } catch {
                                send(rejection(id, error.localizedDescription))
                            }
                        }
                        continue
                    }
                    if ["workspace/list", "workspace/remove"].contains(method) {
                        guard let id else { continue }
                        if method == "workspace/remove" {
                            let params = packet["params"] as? [String: Any]
                            guard let directory = params?["path"] as? String, directory.hasPrefix("/"), directory != workspace.path else {
                                throw RequestError("默认工作目录不可移除。")
                            }
                            let record = workspaceRecord(directory)
                            if manager.fileExists(atPath: record.path) { try manager.removeItem(at: record) }
                        }
                        send(["id": id, "result": ["default": workspace.path, "paths": availableWorkspaces(workspace),
                                                    "selected": NSNull()]])
                        continue
                    }
                    state.lock.lock()
                    let outgoing: [String: Any]
                    do {
                        defer { state.lock.unlock() }
                        var params = try requestParams(method, packet["params"] as? [String: Any] ?? [:],
                                                       workspace: workspace, allowed: state.allowed, policy: policy)
                        if ["thread/start", "thread/resume"].contains(method), lark != nil {
                            if method == "thread/start" { params["dynamicTools"] = [docTool] }
                            params["developerInstructions"] = policy.instructions + """

                            For a docx/wiki document in this turn's workspace, use sidepanel_document for reads and supported edits. Its host runs the CLI as user. If the tool is unavailable in this older conversation, tell the user to use the panel's New conversation button and retry there. Do not retry the same operation through shell commands or a browser. Report the host's diagnostic when the tool fails. The existing CLI workflow still applies to operations beyond the tool’s supported scope.
                            """
                        }
                        if method == "turn/start", let id, let raw = packet["params"] as? [String:Any], let thread = raw["threadId"] as? String {
                            if let token = raw["attachmentBatch"] as? String {
                                let additional = try attachments.inputs(for: token, thread: thread)
                                params["input"] = (params["input"] as? [[String: Any]] ?? []) + additional
                            }
                            if let tokens = raw["localAttachments"] as? [String] {
                                let additional = try localReferences.inputs(for: tokens)
                                params["input"] = (params["input"] as? [[String: Any]] ?? []) + additional
                            }
                            state.submittedDocs[id] = (thread,Set(raw["writeTargets"] as? [String] ?? []))
                        }
                        if let id { state.pending[id] = method }
                        outgoing = ["method": method, "params": params]
                    }
                    var request = outgoing
                    if let id { request["id"] = id }
                    try forward(request)
                } catch {
                    if let id { send(rejection(id, error.localizedDescription)) }
                }
            }
        } catch { return }
    }

    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 32 * 1024)
    while true {
        let count = chunk.withUnsafeMutableBytes { Darwin.read(responseHandle.fileDescriptor, $0.baseAddress, $0.count) }
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { break }
        buffer.append(contentsOf: chunk.prefix(count))
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard let packet = decode(line) else { continue }
            if let method = packet["method"] as? String {
                if method == "item/tool/call", let id = packet["id"], let params = packet["params"] as? [String:Any],
                   params["tool"] as? String == "sidepanel_document", let cli = lark,
                   let turn = params["turnId"] as? String, let thread = params["threadId"] as? String,
                   let args = params["arguments"] as? [String:Any] {
                    state.lock.lock()
                    let scope = state.turnDocs[turn]
                    state.lock.unlock()
                    let permitted = scope?.0 == thread ? scope!.1 : Set<String>()
                    let environment = env
                    DispatchQueue.global().async {
                        let success: Bool
                        let text: String
                        do {
                            guard state.docSlot.wait(timeout:.now()) == .success else { throw RequestError("已有文档操作正在执行。") }
                            defer { state.docSlot.signal() }
                            text = try runDocumentTool(args, documents:permitted, cli:cli, env:environment) {
                                state.lock.lock()
                                defer { state.lock.unlock() }
                                return state.turnDocs[turn]?.0 == thread
                            }
                            success = true
                        } catch { text = error.localizedDescription; success = false }
                        try? forward(["id":id,"result":["success":success,"contentItems":[["type":"inputText","text":text]]]])
                    }
                } else if let id = packet["id"] {
                    try forward(["id": id, "error": ["code": -32601, "message": "Interactive approval is unavailable."]])
                } else if method == "account/updated" {
                    state.lock.lock()
                    state.turnDocs.removeAll()
                    let hadScope = state.accountChecked || !state.allowed.isEmpty
                    state.allowed.removeAll()
                    state.lock.unlock()
                    if hadScope {
                        send(["bridgeError": "Codex 账号状态已变化，请重新连接。"])
                        process.terminate()
                    }
                } else if events.contains(method) {
                    if method == "item/started" || method == "item/completed" {
                        guard var params = packet["params"] as? [String: Any],
                              let item = params["item"] as? [String: Any],
                              let type = item["type"] as? String, itemTypes.contains(type) else { continue }
                        params["item"] = item.filter { ["id", "type", "text"].contains($0.key) }
                        send(["method": method, "params": params])
                    } else if method == "turn/completed",
                              var params = packet["params"] as? [String: Any],
                              let turn = params["turn"] as? [String: Any] {
                        if let id = turn["id"] as? String { state.lock.lock(); state.turnDocs.removeValue(forKey:id); state.lock.unlock() }
                        params["turn"] = turn.filter { ["id", "status", "error"].contains($0.key) }
                        send(["method": method, "params": params])
                    } else { send(packet) }
                }
            } else if let id = packet["id"] as? Int {
                state.lock.lock()
                if let scope = state.submittedDocs.removeValue(forKey:id), let result = packet["result"] as? [String:Any],
                   let turn = result["turn"] as? [String:Any], let tid = turn["id"] as? String { state.turnDocs[tid] = scope }
                let method = state.pending.removeValue(forKey: id)
                if method == "account/read" { state.accountChecked = true }
                let response = method.map { filteredResponse(packet, method: $0, allowed: &state.allowed, policy: policy) }
                state.lock.unlock()
                if let response { send(response) }
            }
        }
        if buffer.count > 8 * 1024 * 1024 {
            send(["bridgeError": "Codex 返回的消息过大。"])
            process.terminate()
            return
        }
    }
    process.waitUntilExit()
}

signal(SIGPIPE, SIG_IGN)
do {
    try run()
} catch {
    send(["bridgeError": "本机连接器无法启动或连接 Codex。"])
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
}
