# a Studio Flow whose definition is invalid, so widgets never run

The Flow looks finished. The canvas renders, the widgets are connected, the Console opens it and saves it without complaint. But executions end two widgets in, or skip a branch that is plainly drawn on screen, and valid on the Flow resource is false. The picture is a drawing of a definition, and the drawing does not stop being tidy when the definition stops compiling.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/studio-flow-invalid-definition/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_studio_flow_validity_audit.py
node node/twilio-studio-flow-validity-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_studio_flow_validity_audit.py
node --test node/twilio-studio-flow-validity-audit.test.mjs
```
