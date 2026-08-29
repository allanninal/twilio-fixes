# a bundle is noncompliant on a field only Evaluations names

The bundle has every document somebody could think of attached to it, and it still will not go anywhere. The status reads draft. Submitting bounces. Nothing says why, and the natural response is to attach another document and try again. Twilio already knows the answer: a machine evaluated the bundle against the regulation, found one attribute wrong, and wrote it down in a subresource that most teams never call.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/bundle-evaluation-noncompliant/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_bundle_evaluation_audit.py
node node/twilio-bundle-evaluation-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_bundle_evaluation_audit.py
node --test node/twilio-bundle-evaluation-audit.test.mjs
```
