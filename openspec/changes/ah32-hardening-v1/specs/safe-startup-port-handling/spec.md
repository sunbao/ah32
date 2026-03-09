## ADDED Requirements

### Requirement: Non-destructive port conflict handling by default
When the configured server port is already in use, the server SHALL NOT terminate other processes by default.

#### Scenario: Port is occupied by a non-AH32 process
- **WHEN** AH32 starts and the configured port is already listening but does not identify as an AH32 instance
- **THEN** AH32 exits with a clear error message describing the conflict and remediation steps

### Requirement: Detect existing AH32 instance
If the configured port is in use and the listener responds with a valid AH32 health payload (e.g., JSON containing `status` and `version` fields), the server SHALL treat the service as "already running" and SHALL NOT kill it.

#### Scenario: Existing instance is running
- **WHEN** AH32 starts and `GET http://127.0.0.1:<port>/health` returns a valid AH32 payload
- **THEN** the process exits without terminating the existing instance and logs how to use the running service

### Requirement: Explicit force cleanup mode
The server SHALL support an explicit opt-in mode `AH32_PORT_CONFLICT_MODE` with values:
- `fail` (default): do not terminate processes
- `reuse`: treat an existing AH32 instance as already running
- `force_kill`: attempt to terminate a previous AH32 instance occupying the port

In `force_kill` mode, the server SHALL still refuse to terminate an occupant that cannot be verified as a previous AH32 instance.

#### Scenario: Force cleanup is refused for unknown occupant
- **WHEN** `AH32_PORT_CONFLICT_MODE=force_kill` and the port occupant cannot be verified as a previous AH32 instance
- **THEN** the server refuses to terminate the process and exits with an error explaining why
