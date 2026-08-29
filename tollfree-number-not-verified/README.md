# an unverified toll-free number is blocked, not throttled

Toll-free was the easy option: no brand, no campaign, no EIN, buy the number and send. That stopped being true on 31 January 2024. Unverified toll-free traffic to US and Canadian mobiles is now blocked outright rather than throttled, every message comes back 30032, and you are still billed for the attempts.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/tollfree-number-not-verified/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tollfree_verification_audit.py
node node/twilio-tollfree-verification-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_tollfree_verification_audit.py
node --test node/twilio-tollfree-verification-audit.test.mjs
```
