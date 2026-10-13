--!strict

tern.command({
	id = "open-panel",
	title = "Carly Switch: Voice Settings",
	icon = "settings",
	run = function(cx)
		if tern.runtime.os ~= "macos" or cx.hosts:current().kind ~= "local" then
			cx:toast("error", "Open a local macOS session", "Carly Switch manages only the local omp entry point, not remote hosts.")
			return
		end
		if not cx:new_block("carly-switch.panel", {}, "beside") then
			cx:toast("error", "Carly Switch panel is unavailable", "Check that the carly-switch plugin is enabled.")
		end
	end,
})
