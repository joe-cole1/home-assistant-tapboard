# Home Assistant `tapboard_event` contract

Tapboard sends one Home Assistant event type, `tapboard_event`, through the authenticated HA WebSocket. Batch 7 does not install, edit, reload, or run automations. These examples are operator-owned starting points.

## Envelope version 1

```yaml
schema_version: 1
event_id: 8bed272b-1a5c-4d31-a911-26b174a210c9
event_type: pour_complete
occurred_at: '2026-08-09T20:10:30.000Z'
tap_id: 2
lifecycle_id: 41
batch_id: abc123
metadata:
  display_name: Native IPA
  display_style: American IPA
data:
  volume_poured_oz: 12.5
```

All IDs except `event_id` may be `null`. Metadata contains only optional bounded `display_name` and `display_style`. Event-specific `data` fields are strict:

| `event_type`     | Allowed `data`                                               |
| ---------------- | ------------------------------------------------------------ |
| `keg_assigned`   | `assignment_kind`: `brewfather`, `custom`, or `override`     |
| `keg_ended`      | `reason`: `end_batch`, `end_keg`, `reassigned`, or `cleared` |
| `pour_start`     | `start_volume_oz`                                            |
| `pour_complete`  | `volume_poured_oz`                                           |
| `pour_cancelled` | bounded detector cancellation `reason`                       |
| `low_keg`        | `current_percent`, `threshold_percent`                       |

Events are operational and best effort. They are not replayed after a long disconnect. Automation delivery failure does not undo a pour, assignment, or end action. Consumers that need deduplication can retain `event_id` for their own short operational window.

No event contains gravity, fermentation temperature, fermentation progress/status, readiness, controller state, notes, taste logs, recipes, credentials, action targets, or arbitrary service data.

## Global notification example

```yaml
automation:
  - alias: Tapboard pour notification
    triggers:
      - trigger: event
        event_type: tapboard_event
        event_data:
          event_type: pour_complete
    actions:
      - action: notify.mobile_app_operator_phone
        data:
          title: Tapboard pour
          message: >-
            Tap {{ trigger.event.data.tap_id }} poured
            {{ trigger.event.data.data.volume_poured_oz }} oz of
            {{ trigger.event.data.metadata.display_name | default('the assigned beverage', true) }}.
```

## Tap-specific light example

```yaml
automation:
  - alias: Tap 2 low keg light
    triggers:
      - trigger: event
        event_type: tapboard_event
        event_data:
          event_type: low_keg
          tap_id: 2
    actions:
      - action: light.turn_on
        target:
          entity_id: light.tap_2_status
        data:
          color_name: orange
```

## External routing example

Keep destinations and credentials in Home Assistant, not Tapboard. For example, an operator can route a subset through an existing HA script:

```yaml
automation:
  - alias: Route Tapboard keg ends
    triggers:
      - trigger: event
        event_type: tapboard_event
        event_data:
          event_type: keg_ended
    actions:
      - action: script.route_tapboard_keg_end
        data:
          tap_id: '{{ trigger.event.data.tap_id }}'
          reason: '{{ trigger.event.data.data.reason }}'
          beer_name: "{{ trigger.event.data.metadata.display_name | default('', true) }}"
```

Do not use Tapboard events to infer or control fermentation. Existing fermentation entities, controllers, scripts, notifications, and dashboards remain independently owned by Home Assistant.
