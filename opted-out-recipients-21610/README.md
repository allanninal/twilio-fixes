# sends to recipients who texted STOP bounce with 21610

Someone replied STOP four months ago. Twilio recorded it, blocked that sender from reaching them, and has been rejecting your sends with 21610 ever since. You were never charged, so nothing showed up on the bill; your send queue treated the rejection as a transient failure and retried; and the only place the whole story exists is the Messages list, which has no filter for it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/opted-out-recipients-21610/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_opt_out_audit.py
node node/twilio-opt-out-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_opt_out_audit.py
node --test node/twilio-opt-out-audit.test.mjs
```
