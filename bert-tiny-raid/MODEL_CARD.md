---
license: mit
base_model:
- prajjwal1/bert-tiny
pipeline_tag: text-classification
library_name: transformers
---
# BERT-tiny RAID Detector

This model is used to detect AI-generated texts from the RAID dataset. 
The model outputs a score corresponding to the likelihood that the text is human. 

This model was trained on a stratified subset of RAID's training data. 


# Model Details

- Base Model: `prajjwal1/bert-tiny`
- Optimizer: `Adam`
- Loss Function: `FocalLoss`
- Hyperparameters:
    - Learning rate: `5e-5`
    - Epochs: 5
    - Learning rate: `1e-5`
    - Epochs: 5