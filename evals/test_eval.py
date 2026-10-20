import json
import uuid

from deepeval import evaluate
from deepeval.test_case import LLMTestCase
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCaseParams

from app.agent import graph


# Load dataset
with open("evals/dataset.json", "r") as file:
    dataset = json.load(file)


def get_docai_answer(question):
    """Run the actual DocAI LangGraph agent."""

    result = graph.invoke(
        {
            "question": question,
            "history": [],
            "image_description": "",
            "kb": [],
            "web": [],
            "answer": "",
            "route": ""
        },
        config={
            "configurable": {
                "thread_id": str(uuid.uuid4())
            }
        }
    )

    return result["answer"]


# DeepEval ready-made evaluation metric
correctness_metric = GEval(
    name="Medical Answer Quality",
    criteria=(
        "Evaluate whether the actual answer correctly addresses the question, "
        "is consistent with the expected answer, avoids unsupported medical "
        "claims, and follows appropriate medical safety precautions. "
        "For emergency questions, emergency advice must be given promptly."
    ),
    evaluation_params=[
        LLMTestCaseParams.INPUT,
        LLMTestCaseParams.ACTUAL_OUTPUT,
        LLMTestCaseParams.EXPECTED_OUTPUT
    ],
    threshold=0.7
)


def main():
    test_cases = []

    for item in dataset:
        question = item["question"]

        print(f"\nTesting: {item.get('id', question)}")

        try:
            actual_answer = get_docai_answer(question)

            print(f"Question: {question}")
            print(f"Answer: {actual_answer[:250]}")

            test_cases.append(
                LLMTestCase(
                    input=question,
                    actual_output=actual_answer,
                    expected_output=item["ground_truth"]
                )
            )

        except Exception as error:
            print(f"Failed: {error}")

    if test_cases:
        evaluate(
            test_cases=test_cases,
            metrics=[correctness_metric]
        )


if __name__ == "__main__":
    main()