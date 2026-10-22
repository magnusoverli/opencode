// Synthetic package: no real entities, credentials, or live Home Assistant calls.
export const packageYaml = `automation:
  - id: synthetic_nested
    alias: "Nested automation"
    triggers:
      - trigger: state
        entity_id: binary_sensor.synthetic_motion
    actions:
      - choose:
          - conditions:
              - condition: state
                entity_id: binary_sensor.synthetic_motion
                state: "on"
            sequence:
              - action: light.turn_on
                target:
                  entity_id: light.synthetic
        default:
          - action: light.turn_off
            target:
              entity_id: light.synthetic
template:
  - triggers:
      - trigger: state
        entity_id: sensor.synthetic_source
    sensor:
      - name: "Synthetic triggered sensor"
        state: "{{ trigger.to_state.state }}"
    binary_sensor:
      - name: "Synthetic binary sensor"
        state: "{{ is_state('sensor.synthetic_source', 'on') }}"
script:
  synthetic_script:
    alias: "Named script before sequence"
    description: >
      Literal Z and trigger: or action: text must not split YAML definitions.
    sequence:
      - repeat:
          count: 2
          sequence:
            - action: light.turn_on
              target:
                entity_id: light.synthetic
`;
