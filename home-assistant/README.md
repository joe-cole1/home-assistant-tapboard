# Home Assistant installation

This directory makes the Tapboard repository self-contained. It includes the
Home Assistant packages required by the container, plus separate instructions
for a clean installation and an existing Home Assistant instance.

## Included files

- `packages/tapboard.yaml` defines the six tap batch-info sensors, batch
  selectors, placeholder telemetry for taps without scales, and the
  `script.end_tap_batch` service.
- `packages/brewfather_tapboard.yaml` defines the Brewfather API v2 REST
  commands and the sanitized active-batch sensor used by Tapboard.
- `packages/tapboard_helpers.yaml` defines the refresh button and six batch,
  capacity, and enabled helpers. Install it only when those helpers do not
  already exist.

The package files contain no credentials. Brewfather credentials remain in
Home Assistant's `secrets.yaml`; the Tapboard container's long-lived HA token
remains in its ignored `.env` file.

## Prerequisites

1. Home Assistant must load named packages:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

2. Add these keys to `/config/secrets.yaml` using your own Brewfather API
   credentials:

   ```yaml
   brewfather_user_id: YOUR_USER_ID
   brewfather_api_key: YOUR_API_KEY
   ```

3. For every physical scale, provide the canonical remaining-volume entity
   `sensor.tap_N_fl_oz` in fluid ounces. Tapboard deliberately does not consume
   `sensor.tap_N_pints_remaining` or percentage-only sensors.
4. Create a full Home Assistant backup before changing package files.

Never commit `secrets.yaml`, a Home Assistant access token, backup contents, or
real credentials to this repository.

## Clean Home Assistant installation

Use this path when the listed Tapboard and Brewfather entities do not already
exist.

1. Copy all three files from `home-assistant/packages/` into
   `/config/packages/`:

   ```text
   /config/packages/tapboard.yaml
   /config/packages/brewfather_tapboard.yaml
   /config/packages/tapboard_helpers.yaml
   ```

2. Add the two Brewfather secret keys described above.
3. Run Home Assistant's **Check configuration** action.
4. Fix every duplicate entity, duplicate top-level key, missing secret, and
   template error before continuing.
5. Restart Home Assistant. Package loading, REST commands, and trigger-based
   template entities require a full restart for a deterministic activation.
6. Press `input_button.brewery_brewfather_refresh` once.
7. Complete the verification checklist below, then configure the Tapboard
   container using the repository's root README.

## Existing Home Assistant installation

Use this path when Tapboard helpers or a broader Brewfather/fermentation
package already exists.

### 1. Inventory and back up

Before copying anything, check whether these entities already exist:

- `input_button.brewery_brewfather_refresh`
- `input_text.tap_1_batch` through `input_text.tap_6_batch`
- `input_number.tap_1_keg_capacity_oz` through
  `input_number.tap_6_keg_capacity_oz`
- `input_boolean.tap_1_enabled` through `input_boolean.tap_6_enabled`
- `sensor.brewfather_active_batches`
- `rest_command.brewfather_list_batches`
- `rest_command.brewfather_get_batch`
- `rest_command.brewfather_complete_batch`

Create a full HA backup and make copies of every package file you will edit.

### 2. Install the Tapboard package

Replace an older Tapboard-only `/config/packages/tapboard.yaml` with the
bundled `packages/tapboard.yaml`.

Do not copy `tapboard_helpers.yaml` when the helpers already exist as UI/storage
helpers. Home Assistant must have exactly one owner for each helper entity ID.
If only some helpers are missing, create those missing helpers in the HA UI or
copy only their YAML definitions into an existing helper package.

### 3. Install the standalone Brewfather package

Copy `packages/brewfather_tapboard.yaml` to
`/config/packages/brewfather_tapboard.yaml`. Keep it as its own package; do not
merge it into a broader brewery or fermentation file.

If an existing package currently defines any of the following, remove those
definitions from that package so the new standalone file is their only owner:

- `rest_command.brewfather_list_batches`
- `rest_command.brewfather_get_batch`
- `rest_command.brewfather_complete_batch`
- the trigger-based template sensor with
  `unique_id: brewfather_active_batches`

Retain every unrelated fermenter sensor, selector, schedule, automation, and
script. Existing fermentation templates can continue calling the same REST
commands and reading `sensor.brewfather_active_batches`; only ownership moves
to the standalone package.

Do not add the bundled refresh-button helper if
`input_button.brewery_brewfather_refresh` already exists.

The active-batch template keeps the last successful batch list if Brewfather
returns an error or malformed body. It publishes only bounded fields for
Planning, Fermenting, and Conditioning batches.

### 4. Remove retired HA configuration

After installing the replacement packages and confirming there are no other
consumers:

- Delete the old `packages/kegerator.yaml` Taplist-era package if it is unused.
- Remove `shell_command.write_tapboard_json` from `configuration.yaml`.
- Delete `/config/shell/write_tapboard_json.py` if it exists.
- Delete the legacy `input_text.tapboard_custom_beverages` helper. Tapboard's
  SQLite database now owns the editable custom beverage.
- Remove obsolete `sensor.tap_N_pints_remaining` consumers. Do not remove the
  canonical `sensor.tap_N_fl_oz` measurement entity.

Search automations, scripts, scenes, dashboards, Node-RED, and external clients
before deleting an entity or service. A repository search alone cannot prove a
live Home Assistant consumer is absent.

## Validate and activate

1. Run Settings > System > Repairs > three-dot menu > **Check configuration**.
2. Do not restart if validation reports an error.
3. Restart Home Assistant after a successful check.
4. Press `input_button.brewery_brewfather_refresh` once.

## Verification checklist

- `sensor.brewfather_active_batches` has `refresh_status: ok`, a recent
  `last_success_at`, and a `batches` list containing only Planning,
  Fermenting, and Conditioning entries.
- `select.tap_1_batch_select` through `select.tap_6_batch_select` exist and
  include `custom:topo_chico | Tapboard Custom Beverage`.
- `sensor.tap_1_batch_info` through `sensor.tap_6_batch_info` exist.
- `input_text.tap_1_batch` through `input_text.tap_6_batch` accept assignments.
- `input_number.tap_1_keg_capacity_oz` through
  `input_number.tap_6_keg_capacity_oz` accept values from 16 to 2048 fl oz.
- Tap 4-6 placeholder volume, weight, and raw entities are `unavailable`; they
  never publish fabricated numeric telemetry.
- `rest_command.brewfather_list_batches`,
  `rest_command.brewfather_get_batch`, and
  `rest_command.brewfather_complete_batch` are registered.
- Saving a tap assignment in Tapboard updates the matching HA batch helper and
  selector.
- The On Deck refresh control updates the sanitized Brewfather batch list.

## Rollback

If configuration validation fails, restore the copied package files and do not
restart. If a failure appears only after restart, restore the pre-install Home
Assistant backup or the copied package files, restart again, and verify the
previous entities before retrying the installation.
