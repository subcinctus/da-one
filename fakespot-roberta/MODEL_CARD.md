---
license: apache-2.0
language:
- en
base_model:
- FacebookAI/roberta-base
pipeline_tag: text-classification
library_name: transformers
---

# RoBERTa-base AI Text Detector

Finetuned RoBERTa-base model for detecting AI generated English texts.

See [FakespotAILabs/ApolloDFT](https://github.com/FakespotAILabs/ApolloDFT) for more details and a technical report of the model and experiments we conducted.

## How to use

You can use this model directly with a pipeline.

For better performance, you should apply the `clean_text` function in [utils.py](utils.py).

```python
from transformers import pipeline
from utils import clean_text

classifier = pipeline(
    "text-classification",
    model="fakespot-ai/roberta-base-ai-text-detection-v1"
)

# single text
text = "text 1"
classifier(clean_text(text))
[   
    {
        'label': str,
        'score': float
    }
]

# list of texts
texts = ["text 1", "text 2"]
classifier([clean_text(t) for t in texts])
[   
    {
        'label': str,
        'score': float
    },
    {
        'label': str,
        'score': float
    }
]
```

## Disclaimer

- The model's score represents an estimation of the likelihood of the input text being AI-generated or human-written, rather than indicating the proportion of the text that is AI-generated or human-written.
- The accuracy and performance of the model generally improve with longer text inputs.
