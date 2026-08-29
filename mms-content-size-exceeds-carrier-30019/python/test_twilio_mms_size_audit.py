from twilio_mms_size_audit import (error_code, media_count, mms_tally,
                                   sender_verdict, size_verdict)


def mms(sid, code=None, media="1", sender="+15550001111"):
    return {"sid": sid, "from": sender, "status": "undelivered",
            "error_code": code, "num_media": media, "direction": "outbound-api"}


def test_error_code_reads_strings_and_numbers_the_same():
    assert error_code({"error_code": 30019}) == 30019
    assert error_code({"error_code": "30019"}) == 30019
    assert error_code({}) is None


def test_num_media_arrives_as_a_string_and_zero_is_truthy():
    # The whole reason this is a function: "0" is a truthy string, so a
    # truthiness test counts every SMS in the account as an MMS.
    assert media_count({"num_media": "0"}) == 0
    assert media_count({"num_media": "1"}) == 1
    assert media_count({"num_media": 2}) == 2
    assert media_count({}) == 0
    assert media_count({"num_media": "not a number"}) == 0


def test_tally_counts_only_messages_that_carry_media():
    rows = mms_tally([mms("SM1", 30019), mms("SM2"), mms("SM3", media="0"),
                      {"sid": "SM4", "direction": "inbound", "num_media": "1"}])
    assert rows["+15550001111"] == {"mms": 2, "oversize": 1, "sids": ["SM1"]}


def test_tally_groups_on_the_messaging_service_when_there_is_one():
    m = mms("SM1", 30019)
    m["messaging_service_sid"] = "MG1"
    assert set(mms_tally([m])) == {"MG1"}


def test_the_size_ladder_holds_at_every_boundary():
    assert size_verdict(300000)[0] == "safe"
    assert size_verdict(300001)[0] == "at-risk"
    assert size_verdict(600000)[0] == "at-risk"
    assert size_verdict(600001)[0] == "carrier-dependent"
    assert size_verdict(3500000)[0] == "carrier-dependent"
    assert size_verdict(3500001)[0] == "over-carriers"
    assert size_verdict(5000000)[0] == "over-carriers"
    assert size_verdict(5000001)[0] == "over-twilio"


def test_the_ladder_takes_content_length_as_the_string_a_header_is():
    state, detail = size_verdict("4200000")
    assert state == "over-carriers"
    assert "4200 kB" in detail


def test_a_missing_or_unparseable_content_length_is_unknown_not_safe():
    assert size_verdict(None)[0] == "unknown"
    assert size_verdict("")[0] == "unknown"
    assert size_verdict("chunked")[0] == "unknown"


def test_the_carrier_dependent_band_explains_the_partial_failures():
    _, detail = size_verdict(1200000)
    assert "one recipient gets the image and the next gets 30019" in detail


def test_a_sender_with_no_failures_is_clean():
    state, detail = sender_verdict({"mms": 40, "oversize": 0})
    assert state == "clean"
    assert "40" in detail


def test_most_of_the_mms_failing_means_no_carrier_takes_it():
    state, detail = sender_verdict({"mms": 10, "oversize": 8})
    assert state == "every-carrier"
    assert "nobody is receiving it" in detail


def test_a_minority_failing_is_the_carrier_dependent_case():
    state, detail = sender_verdict({"mms": 100, "oversize": 12})
    assert state == "carrier-dependent"
    assert "phone in your hand" in detail


def test_a_sender_with_no_mms_at_all_says_so():
    state, _ = sender_verdict({"mms": 0, "oversize": 0})
    assert state == "no-mms"
