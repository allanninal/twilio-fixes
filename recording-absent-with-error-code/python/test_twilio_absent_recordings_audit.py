from twilio_absent_recordings_audit import source_meaning, verdict


def test_absent_row_names_the_error_code_and_the_source():
    state, detail = verdict({"status": "absent", "error_code": 12400,
                             "source": "DialVerb"})
    assert state == "absent"
    assert "error_code 12400" in detail
    assert "Dial verb" in detail


def test_absent_row_without_an_error_code_says_so():
    state, detail = verdict({"status": "absent", "source": "RecordVerb"})
    assert state == "absent"
    assert "unusual" in detail


def test_completed_with_zero_duration_is_its_own_finding():
    state, detail = verdict({"status": "completed", "duration": "0"})
    assert state == "empty"
    assert "no audio" in detail


def test_completed_with_media_is_stored():
    assert verdict({"status": "completed", "duration": "671"})[0] == "stored"


def test_in_progress_is_a_moment_not_a_fault():
    assert verdict({"status": "processing"})[0] == "in-flight"


def test_deleted_row_survives_the_media():
    state, detail = verdict({"status": "deleted"})
    assert state == "deleted"
    assert "recording sid" not in detail


def test_trunking_source_has_nowhere_to_put_a_per_call_callback():
    assert "trunk itself" in source_meaning("Trunking")


def test_unrecognised_source_does_not_invent_a_place_for_the_callback():
    assert "not one this script recognises" in source_meaning("SomethingNew")
