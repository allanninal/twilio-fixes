# a rising share of outbound calls end in status failed

Nobody can point at an error. Support says calls are not going through; the Debugger has its usual scattering of alerts and none of them is new; the code has not changed. What has changed is a ratio: the share of outbound calls ending in failed rather than completed. A ratio is not an event, so nothing raised it, and nothing will &mdash; you have to go and compute it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/outbound-call-failure-rate-spike/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_call_failure_rate_audit.py
node node/twilio-call-failure-rate-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_call_failure_rate_audit.py
node --test node/twilio-call-failure-rate-audit.test.mjs
```
