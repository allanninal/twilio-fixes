# high risk dialing prefixes left open to toll fraud

This is the note in the section where nothing is broken. Every call succeeds, every setting is at its default, and the finding is an invoice you have not received yet. High-risk special-service and toll-fraud ranges stay dialable on an upgraded account until somebody switches them off, and the people who look for accounts in that state do it at scale and at three in the morning.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/high-risk-dialing-permissions-open/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_high_risk_dialing_audit.py
node node/twilio-high-risk-dialing-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_high_risk_dialing_audit.py
node --test node/twilio-high-risk-dialing-audit.test.mjs
```
