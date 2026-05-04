module github.com/emanspeaks/atopweb

go 1.25.0

require github.com/gorilla/websocket v1.5.3

require golang.org/x/sys v0.43.0

require (
	github.com/emanspeaks/amdgpu-go v0.0.0
	github.com/godbus/dbus/v5 v5.2.2
)

replace github.com/emanspeaks/amdgpu-go v0.0.0 => ./amdgpu-go
