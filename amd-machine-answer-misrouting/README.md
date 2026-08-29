# answering machine detection is routing humans to voicemail

Connect rates are down and nobody can say why. The calls go out, they are answered, they last a few seconds, and they end. Every one of them is completed. What happened is that a person said hello, Twilio decided they were an answering machine, and your flow did what you told it to do for machines: it started a voicemail drop at somebody who was standing there holding the phone.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/amd-machine-answer-misrouting/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_amd_classification_audit.py
node node/twilio-amd-classification-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_amd_classification_audit.py
node --test node/twilio-amd-classification-audit.test.mjs
```
