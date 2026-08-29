# a rejected toll-free record's edit window closes on a clock

The rejection came in ten days ago. Somebody read it, agreed the opt-in wording needed work, put it on the board, and the board is long. Nothing has broken since: the number was already blocked, the status has read TWILIO_REJECTED the whole time, and it will read that tomorrow too. What changes tomorrow is edit_expiration, and after it passes the correction that would have taken twenty minutes becomes a fresh submission at the back of a queue measured in weeks.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/tollfree-edit-window-expiring/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tollfree_edit_window.py
node node/twilio-tollfree-edit-window.mjs
```

## Test it

```bash
pytest python/test_twilio_tollfree_edit_window.py
node --test node/twilio-tollfree-edit-window.test.mjs
```
