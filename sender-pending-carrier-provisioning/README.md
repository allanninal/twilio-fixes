# 30035 and 30024 are a clock, not a configuration mistake

The number was added to the Messaging Service an hour before the launch, which felt like plenty of margin. Sends come back 30035. Somebody removes the number and adds it again, because that is what you do when a config change did not take. The clock they were forty minutes from the end of has just been set back to zero, and they will do it twice more before the day is out.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sender-pending-carrier-provisioning/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sender_provisioning_clock.py
node node/twilio-sender-provisioning-clock.mjs
```

## Test it

```bash
pytest python/test_twilio_sender_provisioning_clock.py
node --test node/twilio-sender-provisioning-clock.test.mjs
```
