--!strict
-- Native utility panel. Drafts stay in VM memory and are never persisted by Tern.
-- The renderer receives only API-key masks; the helper receives the key only on stdin.
local ui = tern.ui
local DEFAULT_VOICE = "zh_female_vv_jupiter_bigtts"
local VOICES = {
	{ id = DEFAULT_VOICE, label = "Vivi · Female" },
	{ id = "zh_female_xiaohe_jupiter_bigtts", label = "Xiaohe · Female" },
	{ id = "zh_male_yunzhou_jupiter_bigtts", label = "Yunzhou · Male" },
	{ id = "zh_male_xiaotian_jupiter_bigtts", label = "Xiaotian · Male" },
}

type Build = {
	state: string,
	stage: string,
	elapsedSeconds: number,
	logPath: string,
	message: string,
}

type State = {
	status: any,
	busy: string,
	error: string,
	message: string,
	apiKey: string,
	provider: string,
	voice: string,
	initialized: boolean,
	confirm: string,
	more: boolean,
	menu: boolean,
	menuCursor: number,
	focus: string,
	cursor: number,
	anchor: number?,
	build: Build?,
	requestId: number,
	pollTimer: TimerHandle?,
	pollInFlight: number?,
	disposed: boolean,
}

local function text(value: any): string
	return if type(value) == "string" then value else ""
end

local function alive(cx: BlockCx): boolean
	for _, pane in tern.pane.list() do
		if pane.pane == cx.pane then return true end
	end
	return false
end

local function length(value: string): number
	local units = 0
	for _, point in utf8.codes(value) do units += if point > 65535 then 2 else 1 end
	return units
end

local function byte_at(value: string, offset: number): number
	local units = 0
	for at, point in utf8.codes(value) do
		local width = if point > 65535 then 2 else 1
		if units + width > offset then return at - 1 end
		units += width
	end
	return #value
end

local function replace(state: State, from: number, to: number, value: string): boolean
	-- Keys are printable ASCII: every source character and every mask is one UTF-16 unit.
	-- Reject non-ASCII instead of allowing a mask caret to split a surrogate pair.
	local clean = if #value > 1 then value:gsub("^%s+", ""):gsub("%s+$", "") else value
	if clean:find("[^!-~]") then
		state.error = "API keys must use ASCII letters, numbers, and symbols without spaces."
		return false
	end
	local old = state.apiKey
	local last = length(old)
	from = math.clamp(math.floor(from), 0, last)
	to = math.clamp(math.floor(to), from, last)
	if #old - (to - from) + #clean > 16384 then
		state.error = "API key is too long. Check your input."
		return false
	end
	state.apiKey = old:sub(1, byte_at(old, from)) .. clean .. old:sub(byte_at(old, to) + 1)
	state.cursor, state.anchor = from + length(clean), nil
	state.error, state.message = "", ""
	return true
end

local function voice_rows(state: State): { any }
	local rows = {}
	local found = false
	for _, voice in VOICES do
		table.insert(rows, voice)
		if voice.id == state.voice then found = true end
	end
	if not found then table.insert(rows, { id = state.voice, label = "Current custom voice" }) end
	return rows
end

local function voice_label(state: State): string
	for _, voice in VOICES do
		if voice.id == state.voice then return voice.label end
	end
	return "Current custom voice"
end

local function focus(state: State, cx: BlockCx, id: string)
	state.focus = id
	cx:frame({ { "focus", if id == "" then tern.json.null else id } })
end

local function open_menu(state: State, cx: BlockCx)
	state.menu = not state.menu
	state.menuCursor = 1
	for index, voice in voice_rows(state) do
		if voice.id == state.voice then state.menuCursor = index end
	end
	focus(state, cx, "main.voice")
end

local function pick_voice(state: State, cx: BlockCx, id: string)
	for _, voice in voice_rows(state) do
		if voice.id == id then
			state.voice, state.menu, state.message = id, false, ""
			focus(state, cx, "main.voice")
			return
		end
	end
end

local function bun_path(): string
	local home = tern.getenv("HOME") or ""
	for _, path in { home .. "/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun" } do
		if tern.fs.exists(path) then return path end
	end
	return "bun"
end

-- Longer than every runtime-build stage cap combined, plus activation margin
-- (runtime-build.mjs SWITCH_TIMEOUT_MS). Stage caps fail and roll back before
-- the configuration transaction. This only stops a helper that itself stopped
-- making progress. Never terminate a configuration transaction halfway through rollback.
local SWITCH_TIMEOUT_MS = 4 * 60 * 60 * 1000
local polling: { [number]: State } = {}

local function valid_build(value: any): boolean
	return value == nil or value == tern.json.null or (type(value) == "table"
		and type(value.state) == "string" and type(value.stage) == "string"
		and type(value.elapsedSeconds) == "number" and value.elapsedSeconds >= 0
		and value.elapsedSeconds < math.huge
		and type(value.logPath) == "string" and type(value.message) == "string")
end

local function stop_polling(state: State, cx: BlockCx)
	if state.pollTimer then state.pollTimer:cancel(); state.pollTimer = nil end
	if polling[cx.pane] == state then polling[cx.pane] = nil end
end

local function poll_build(state: State, cx: BlockCx, requestId: number, bun: string)
	if state.disposed or state.requestId ~= requestId or state.busy ~= "switch" then return end
	if not alive(cx) then
		state.disposed = true
		stop_polling(state, cx)
		return
	end
	state.pollTimer = tern.timer(1000, function()
		state.pollTimer = nil
		if state.disposed or state.requestId ~= requestId or state.busy ~= "switch" then return end
		if not alive(cx) then
			state.disposed = true
			stop_polling(state, cx)
			return
		end
		-- A previous request's late poll may still be exiting. Never overlap polls.
		if state.pollInFlight ~= nil then poll_build(state, cx, requestId, bun); return end
		state.pollInFlight = requestId
		local ok = pcall(function()
			tern.process.run({ bun, tern.plugin.dir .. "/helper.mjs", "build-status" }, {
				cwd = "/", timeout_ms = 5000,
			}, function(result)
				if state.pollInFlight == requestId then state.pollInFlight = nil end
				if state.disposed or state.requestId ~= requestId or state.busy ~= "switch" then return end
				if not alive(cx) then
					state.disposed = true
					stop_polling(state, cx)
					return
				end
				local decoded, reply = pcall(tern.json.decode, result.stdout)
				if result.status == 0 and decoded and type(reply) == "table"
					and reply.action == "build-status" and reply.ok == true and valid_build(reply.build) then
					-- Progress never replaces provider status, drafts, or transaction errors.
					state.build = if type(reply.build) == "table" then reply.build else nil
					cx:render()
				end
				poll_build(state, cx, requestId, bun)
			end)
		end)
		if not ok then
			state.pollInFlight = nil
			poll_build(state, cx, requestId, bun)
		end
	end)
end

tern.on("pane_exited", function(ev)
	local state = polling[ev.pane]
	if not state then return end
	state.disposed = true
	state.requestId += 1
	if state.pollTimer then state.pollTimer:cancel(); state.pollTimer = nil end
	polling[ev.pane] = nil
end)

local function request(state: State, cx: BlockCx, action: string, provider: string?)
	if state.disposed or state.busy ~= "" then return end
	state.confirm, state.error, state.message, state.menu = "", "", "", false
	focus(state, cx, "")
	if tern.runtime.os ~= "macos" then
		state.error = "This plugin requires macOS."
		return
	end
	state.busy = action
	state.requestId += 1
	local requestId = state.requestId
	if action == "switch" then state.build = nil end
	local ok = pcall(function()
		local bun = bun_path()
		local argv = { bun, tern.plugin.dir .. "/helper.mjs", action }
		if provider then table.insert(argv, "--provider"); table.insert(argv, provider) end
		local doubao = action == "check" or (action == "switch" and provider == "doubao")
		if doubao then
			table.insert(argv, "--voice"); table.insert(argv, state.voice)
			if state.apiKey ~= "" then table.insert(argv, "--key-stdin") end
		end
		-- Never terminate a configuration transaction halfway through rollback.
		-- Switch uses the long backstop above; restore is left to finish.
		local timeout_ms = if action == "status" or action == "check" then 60000 elseif action == "switch" then SWITCH_TIMEOUT_MS else nil
		tern.process.run(argv, {
			cwd = "/",
			stdin = if doubao and state.apiKey ~= "" then state.apiKey else nil,
			timeout_ms = timeout_ms,
		}, function(result)
			if state.disposed or state.requestId ~= requestId then return end
			stop_polling(state, cx)
			if not alive(cx) then state.disposed = true; return end
			state.busy = ""
			local decoded, reply = pcall(tern.json.decode, result.stdout)
			if not decoded or type(reply) ~= "table" or reply == tern.json.null
				or type(reply.ok) ~= "boolean" or reply.action ~= action
				or (reply.provider ~= "codex" and reply.provider ~= "doubao")
				or type(reply.installed) ~= "boolean" or type(reply.customBinaryExists) ~= "boolean"
				or type(reply.canAutoBuild) ~= "boolean" or not valid_build(reply.build)
				or type(reply.hasKeyFile) ~= "boolean" or type(reply.restartRequired) ~= "boolean"
				or type(reply.keyFile) ~= "string" or type(reply.voice) ~= "string"
				or type(reply.entry) ~= "string" or type(reply.message) ~= "string"
				or type(reply.version) ~= "string" or reply.version == "" then
				state.status = nil
				state.error = if result.timed_out then "Operation timed out. Refresh the status." else "Unable to read status. Check Bun and the plugin, then refresh."
				-- Unexpected stdout/stderr must never be echoed: it may contain secrets.
			else
				state.status = reply
				state.build = if type(reply.build) == "table" then reply.build else nil
				local success = reply.ok and result.status == 0
				if not state.initialized or (success and (action == "switch" or action == "restore")) then
					state.provider, state.voice = reply.provider, reply.voice
					state.initialized = true
				end
				if success then
					if action == "switch" or action == "restore" then
						state.apiKey, state.cursor, state.anchor = "", 0, nil
					end
					state.message = if action == "switch" then "Saved."
						elseif action == "restore" then "Original runtime restored."
						elseif action == "check" then "Connected. No microphone was started and no draft was saved." else ""
				else
					state.error = if text(reply.error) ~= "" then reply.error else reply.message
					if state.error == "" then state.error = "Operation failed. Refresh the status." end
				end
			end
			cx:render()
		end)
		if action == "switch" then
			polling[cx.pane] = state
			poll_build(state, cx, requestId, bun)
		end
	end)
	if not ok then
		stop_polling(state, cx)
		state.busy, state.status = "", nil
		state.error = "Unable to start the helper. Check Bun and the plugin, then refresh."
	end
end

local function button(label: string, action: string, enabled: boolean, class: string?): Node
	return ui.el("button", {
		key = action, text = label, disabled = not enabled,
		class = "cs-button" .. (if class then " " .. class else ""),
		actions = if enabled then { click = action } else nil,
	})
end

local function row(key: string, kids: { Node }): Node
	return ui.node("row", { key = key }, kids)
end

local function voice_menu(state: State): Node
	local rows = voice_rows(state)
	local items = {}
	for index, voice in rows do
		table.insert(items, ui.node("item", {
			key = voice.id, label = voice.label,
			tone = if index == state.menuCursor then "accent" else "muted",
			actions = { click = "pick_voice=" .. voice.id },
		}))
	end
	return ui.node("overlay", {
		key = "voices", anchor = { node = "main.voice", side = "below" }, size = "sm", head = "Choose a voice",
	}, {
		ui.node("list", {
			key = "choices", selected = "layer.voices.choices." .. rows[state.menuCursor].id,
			max = { lines = 5 },
		}, items),
	})
end

local function confirmation(state: State): Node
	local restore = state.confirm == "restore"
	local build = not restore and state.status ~= nil and not state.status.customBinaryExists and state.status.canAutoBuild
	return ui.node("overlay", {
		key = "confirmation", modal = true, head = if restore then "Restore original runtime?" elseif build then "Build and enable Carly Switch?" else "Enable Carly Switch?",
	}, {
		ui.text(if restore then "Restore the original runtime and voice settings. Restart Tern to apply. The current call is unaffected."
			elseif build then "Download the pinned omp " .. state.status.version .. " source, apply the shipped patch, and build a private runtime. This requires network access and build tools; only official omp " .. state.status.version .. " is supported. The official binary stays unchanged and the original entry point is backed up before enabling. Restart Tern after first enabling. This does not start the microphone or interrupt the current call."
			else "Back up the original entry point and enable voice settings. Restart Tern after first enabling. This will not start the microphone or interrupt the current call."),
		ui.row({ button(if restore then "Restore" elseif build then "Build and enable" else "Enable", "confirm", state.busy == "", "cs-button-primary"),
			button("Cancel", "cancel", state.busy == "", nil) }),
	})
end

local function view(state: State): BlockView
	local status = state.status
	local idle = state.busy == "" and state.confirm == ""
	local ready = idle and status ~= nil and status.customBinaryExists
	local saveReady = idle and status ~= nil and (status.customBinaryExists or status.canAutoBuild)
	local current = if status then (if status.provider == "doubao" then "Current · Doubao" else "Current · OpenAI")
		elseif state.busy == "status" then "Reading status" else "Status unavailable"
	local kids: { Node } = {
		row("head", { ui.text(ui.span("Carly Switch", "strong")), ui.text(ui.span(current, "muted")) }),
		row("providers", {
			button("Doubao", "choose_doubao", idle, if state.provider == "doubao" then "cs-button-selected" else nil),
			button("OpenAI", "choose_codex", idle, if state.provider == "codex" then "cs-button-selected" else nil),
		}),
	}
	if state.provider == "doubao" then
		table.insert(kids, ui.text({ ui.span("API key", "strong"), ui.span(if status and status.hasKeyFile then " · Saved; leave blank to keep" else " · Stored only on this device", "muted") }))
		table.insert(kids, ui.node("input", {
			key = "apiKey", text = string.rep("•", length(state.apiKey)), aria = "Doubao API key",
			placeholder = if status and status.hasKeyFile then "Enter a new key to replace" else "Paste API key",
			readonly = not idle,
			cursor = if state.focus == "main.apiKey" then state.cursor else length(state.apiKey),
			anchor = if state.focus == "main.apiKey" then state.anchor else nil,
		}))
		table.insert(kids, ui.text(ui.span("Voice", "strong")))
		local voice = button(voice_label(state) .. " ▾", "voice", idle, "cs-voice")
		local props = voice.p or {}
		props.attrs = { ["aria-haspopup"] = "listbox", ["aria-expanded"] = tostring(state.menu) }
		voice.p = props
		table.insert(kids, voice)
	else
		table.insert(kids, ui.text(ui.span("Uses your signed-in OpenAI account. No Doubao key is needed.", "muted")))
	end
	table.insert(kids, row("actions", {
		button("Save and apply", "save", saveReady, "cs-button-primary"),
		button("Test connection", "check", ready and state.provider == "doubao", nil),
	}))
	local effect = "Restart Tern after first enabling. Later changes apply to the next call."
	if status and (status.action == "switch" or status.action == "restore") and status.ok then
		effect = if status.restartRequired then "Restart Tern to apply. The current call is unchanged." else "Applies to the next call. The current call is unchanged."
	end
	table.insert(kids, ui.text(ui.span(effect, "muted")))
	if state.busy ~= "" then
		local labels = { status = "Reading status…", switch = "Saving…", check = "Testing connection (no microphone)…", restore = "Restoring…" }
		table.insert(kids, ui.progress(nil, labels[state.busy] or "Working…"))
	end
	local build = state.build
	if build then
		table.insert(kids, ui.text(ui.span("Runtime setup · " .. build.stage .. " · " .. tostring(math.floor(build.elapsedSeconds)) .. "s", "strong")))
		if build.message ~= "" then table.insert(kids, ui.text(build.message)) end
		if build.logPath ~= "" then table.insert(kids, ui.text({ ui.span("Private build log: ", "muted"), ui.path(build.logPath, "/") })) end
	end
	if status and not status.customBinaryExists and state.busy ~= "switch" then
		if status.canAutoBuild then
			table.insert(kids, ui.diagnostic({ severity = "note", message = "First Save downloads and builds a private omp " .. status.version .. " runtime with the shipped patch. Network access and build tools are required. Only official omp " .. status.version .. " is supported; the official binary is preserved." }))
		else
			table.insert(kids, ui.diagnostic({ severity = "error", message = "Configured runtime unavailable. CARLY_SWITCH_OMP is a manual override and is never built or overwritten automatically. Supply a compatible runtime at that path, or unset the override to build on first Save." }))
		end
	end
	if status and text(status.warning) ~= "" then table.insert(kids, ui.diagnostic({ severity = "warning", message = status.warning })) end
	if state.error ~= "" then table.insert(kids, ui.diagnostic({ severity = "error", message = state.error })) end
	if state.message ~= "" then table.insert(kids, ui.text(state.message)) end
	table.insert(kids, button(if state.more then "More ▴" else "More ▾", "more", idle, "cs-more"))
	if state.more then
		table.insert(kids, row("more_actions", {
			button("Refresh status", "refresh", idle, nil),
			button("Restore original runtime", "restore", idle and status ~= nil and text(status.originalTarget) ~= "", nil),
		}))
	end
	local layer = if state.confirm ~= "" then confirmation(state) elseif state.menu then voice_menu(state) else nil
	return { main = ui.col(kids), layer = if layer then ui.col({ layer }) else nil }
end

local function focus_order(state: State): { string }
	local order = { "main.providers.choose_doubao", "main.providers.choose_codex" }
	if state.provider == "doubao" then
		table.insert(order, "main.apiKey")
		table.insert(order, "main.voice")
	end
	if state.status then
		if state.status.customBinaryExists or state.status.canAutoBuild then table.insert(order, "main.actions.save") end
		if state.status.customBinaryExists and state.provider == "doubao" then table.insert(order, "main.actions.check") end
	end
	table.insert(order, "main.more")
	if state.more then
		table.insert(order, "main.more_actions.refresh")
		if state.status and text(state.status.originalTarget) ~= "" then table.insert(order, "main.more_actions.restore") end
	end
	return order
end

local panel: BlockDef<State> = {
	features = { "edit" },
	init = function(cx)
		local state: State = {
			status = nil, busy = "", error = "", message = "", apiKey = "", provider = "doubao", voice = DEFAULT_VOICE,
			initialized = false, confirm = "", more = false, menu = false, menuCursor = 1, focus = "", cursor = 0, anchor = nil,
			build = nil, requestId = 0, pollTimer = nil, pollInFlight = nil, disposed = false,
		}
		request(state, cx, "status", nil)
		return state
	end,
	title = function() return "Carly Switch" end,
	view = function(state) return view(state) end,
	event = function(state, ev, cx)
		if state.busy ~= "" then return end
		local id = text(ev.id)
		if state.confirm == "" and ev.ev == "focus" then
			state.focus = id
			if id == "main.apiKey" then state.cursor, state.anchor = length(state.apiKey), nil end
			return
		end
		if state.confirm == "" and state.provider == "doubao" and id == "main.apiKey" and ev.ev == "edit" then
			state.focus, state.menu = id, false
			if ev.len == nil or ev.len == length(state.apiKey) then
				if replace(state, tonumber(ev.from) or 0, tonumber(ev.to) or 0, text(ev.text)) then
					state.cursor = math.clamp(tonumber(ev.cursor) or state.cursor, 0, length(state.apiKey))
				end
			end
			return
		end
		if ev.ev ~= "action" then return end
		local action = text(ev.act)
		if action == "cancel" then state.confirm = ""; return end
		if action == "confirm" and state.confirm ~= "" then
			local restore = state.confirm == "restore"
			request(state, cx, if restore then "restore" else "switch", if restore then nil else state.provider)
			return
		end
		if state.confirm ~= "" then return end
		if action == "pick_voice" and state.menu then pick_voice(state, cx, text(ev.value)); return end
		if action == "voice" and state.provider == "doubao" then open_menu(state, cx); return end
		state.menu = false
		if action == "choose_doubao" or action == "choose_codex" then
			state.provider, state.message = if action == "choose_doubao" then "doubao" else "codex", ""
			focus(state, cx, "main.providers." .. action)
		elseif action == "more" then state.more = not state.more
		elseif action == "refresh" then request(state, cx, "status", nil)
		elseif action == "check" and state.provider == "doubao" and state.status and state.status.customBinaryExists then
			request(state, cx, "check", "doubao")
		elseif action == "save" and state.status and (state.status.customBinaryExists or state.status.canAutoBuild) then
			if state.status.installed and state.status.customBinaryExists then request(state, cx, "switch", state.provider)
			else state.confirm = "apply"; focus(state, cx, "") end
		elseif action == "restore" and state.status and text(state.status.originalTarget) ~= "" then
			state.confirm = "restore"
			focus(state, cx, "")
		end
	end,
	key = function(state, key, cx)
		if state.busy ~= "" then return true end
		if key.name == "escape" then
			if state.menu then state.menu = false; focus(state, cx, "main.voice")
			else state.confirm = ""; focus(state, cx, "") end
			return true
		end
		if state.confirm ~= "" then return false end
		if state.menu then
			local rows = voice_rows(state)
			if key.name == "up" or key.name == "down" then
				state.menuCursor = (state.menuCursor - 1 + (if key.name == "down" then 1 else -1)) % #rows + 1
				return true
			elseif key.name == "enter" or key.name == "return" or key.name == "space" then
				pick_voice(state, cx, rows[state.menuCursor].id)
				return true
			elseif key.name ~= "tab" then return true end
		end
		if key.name == "f5" then request(state, cx, "status", nil); return true end
		if key.name == "tab" then
			state.menu = false
			local order = focus_order(state)
			local current = if key.shift then 1 else 0
			for index, id in order do if id == state.focus then current = index end end
			local nextIndex = (current - 1 + (if key.shift then -1 else 1)) % #order + 1
			focus(state, cx, order[nextIndex])
			if state.focus == "main.apiKey" then state.cursor, state.anchor = length(state.apiKey), nil end
			return true
		end
		if state.focus == "main.voice" and (key.name == "down" or key.name == "up" or key.name == "enter" or key.name == "return" or key.name == "space") then
			open_menu(state, cx)
			return true
		end
		if state.focus ~= "main.apiKey" or state.provider ~= "doubao" then return false end
		local value = state.apiKey
		local last = length(value)
		if (key.meta or key.ctrl) and key.name == "a" then state.anchor, state.cursor = 0, last; return true end
		local from, to = math.min(state.cursor, state.anchor or state.cursor), math.max(state.cursor, state.anchor or state.cursor)
		if key.name == "paste" then replace(state, from, to, text(key.text)); return true end
		if key.meta or key.ctrl or key.alt then return false end
		local previous, following, units = 0, last, 0
		for _, point in utf8.codes(value) do
			if units < state.cursor then previous = units end
			units += if point > 65535 then 2 else 1
			if units > state.cursor then following = units; break end
		end
		if key.name == "left" or key.name == "right" or key.name == "home" or key.name == "end" then
			local old = state.cursor
			state.cursor = if key.name == "left" then previous elseif key.name == "right" then following elseif key.name == "home" then 0 else last
			if key.shift then state.anchor = state.anchor or old else state.anchor = nil end
			return true
		end
		if key.name == "backspace" then replace(state, if from == to then previous else from, to, "")
		elseif key.name == "delete" then replace(state, from, if from == to then following else to, "")
		elseif text(key.text) ~= "" then replace(state, from, to, text(key.text))
		else return false end
		return true
	end,
}

tern.block.define("panel", panel)
