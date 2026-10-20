from app.agent import graph, stream_graph

def test_non_streaming():
    print("--- 1. Testing non-streaming graph.invoke ---")
    config = {"configurable": {"thread_id": "test_user_sync"}}
    result = graph.invoke(
        {
            "question": "What causes headaches?",
            "history": [],
            "image_description": "",
            "kb": [],
            "web": [],
            "answer": "",
            "route": ""
        },
        config=config
    )
    answer = result.get("answer", "")
    print(f"Non-streaming result received ({len(answer)} chars)")
    assert len(answer) > 0, "Non-streaming answer should not be empty"
    print("Non-streaming test PASSED.\n")

def test_streaming():
    print("--- 2. Testing streaming stream_graph ---")
    config = {"configurable": {"thread_id": "test_user_stream"}}
    tokens = []
    statuses = []
    done_payload = None

    for event_type, payload in stream_graph(
        {
            "question": "How do vaccines work?",
            "history": [],
            "image_description": "",
            "kb": [],
            "web": [],
            "answer": "",
            "route": ""
        },
        config=config
    ):
        if event_type == "status":
            statuses.append(payload.get("message"))
        elif event_type == "token":
            tokens.append(payload)
        elif event_type == "done":
            done_payload = payload

    full_streamed_text = "".join(tokens)
    print(f"Streamed {len(tokens)} chunks, total length: {len(full_streamed_text)} chars")
    print(f"Statuses received: {len(statuses)}")
    assert len(tokens) > 0, "Should receive streaming token chunks"
    assert done_payload is not None, "Should receive done event"
    print("Streaming test PASSED.\n")

if __name__ == "__main__":
    test_non_streaming()
    test_streaming()
    print("ALL TESTS PASSED SUCCESSFULLY!")