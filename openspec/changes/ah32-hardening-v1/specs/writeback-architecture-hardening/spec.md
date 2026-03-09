## ADDED Requirements

### Requirement: Plan is the default writeback format
For writeback operations initiated from the main chat UI, the system SHALL generate a Plan JSON (`schema_version="ah32.plan.v1"`) and execute it in the client.

#### Scenario: Writeback uses Plan JSON
- **WHEN** a user requests a writeback action from the main chat UI
- **THEN** the client executes an `ah32.plan.v1` Plan payload to perform the writeback

### Requirement: Model-macro endpoints are removed
The backend SHALL NOT expose `/agentic/js-macro/*` endpoints.

#### Scenario: js-macro endpoints are absent
- **WHEN** a client calls `/agentic/js-macro/repair` (or any `/agentic/js-macro/*` endpoint)
- **THEN** the server responds with 404 and does not execute model-generated macro code

### Requirement: Core Plan ops execute without model-generated macro code
Executing a Plan containing `answer_mode_apply` or `rollback_block` SHALL NOT require generating or executing arbitrary JS macro code from the model.

#### Scenario: answer_mode_apply runs deterministically
- **WHEN** the client executes a Plan containing `answer_mode_apply`
- **THEN** the operation is performed deterministically by the Plan execution engine without model-generated macro code

### Requirement: Detect schema drift between backend and frontend
The repository SHALL include a machine-readable export of `ah32.plan.v1` and a build-time check that fails when the frontend does not implement an op exported by the backend schema.

#### Scenario: Build fails on unsupported op
- **WHEN** a new Plan op is added to the backend schema export
- **THEN** the frontend build/check fails until the op is implemented or explicitly gated
