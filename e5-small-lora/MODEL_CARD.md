---
tags:
- text-classification
widget:
- text: >-
    This paper presents OASIS, novel one-pass aligned atlas set for image
    segmentation. Traditional atlas-based segmentation methods often require
    multiple iterations of registration, which can be time-consuming and
    computationally expensive. OASIS addresses this limitation by introducing
    one-pass alignment process that efficiently registers template atlas to a
    target image. This process involves two steps: coarse alignment using a deep
    convolutional neural network, followed by a fine alignment using a robust
    multiresolution registration algorithm. Experimental results on various
    medical imaging datasets demonstrate that OASIS achieves competitive
    segmentation accuracy compared to state-of-the-art methods, while
    significantly reducing computation time. Additionally, OASIS exhibits
    robustness against image artifacts and variations, making it suitable for
    wide range of applications in medical imaging and beyond. Overall, this
    paper presents a new approach to atlas-based image segmentation that
    addresses the limitations of traditional methods, and offers improved speed,
    accuracy, and robustness.
  example_title: example1
- text: >-
    High school graduation is often looked upon as a milestone for students to
    celebrate as the end of a long educational journey. However, some school
    districts have begun allowing students to graduate a year early. Though this
    can be beneficial in certain cases, there are several compelling reasons why
    this practice should not be made universally available to all high school
    students. Most importantly, graduates who jump the gun and finish high
    school early could be missing out on valuable learning experiences. High
    school is a formative period and the curriculum is designed to prepare young
    adults for college or the workforce. Skipping ahead by a year could lead to
    students not having enough guidance or mentorship available while learning
    vital skills and life lessons. In addition, early graduation can leave
    students feeling unprepared for the world outside of high school. Not having
    the same college exposure as other peers or lacking the maturity that comes
    with an extra year of school can hold graduates back from success in the
    long-run. Graduating a year earlier than expected does not always mean
    students will attend college earlier; in fact, it could mean starting a
    career ill-equipped to handle all the responsibilities that come with being
    a full-time working adult. For these reasons, schools districts should not
    make it possible for all high school students to graduate a year early. The
    benefits may be enticing, but there are many potential downsides to
    consider.
  example_title: example2
- text: >-
    Summer is a time of hanging out with friends at the beach and relaxing in
    the warm weather, but there is always something that swoops in to mess it
    up: a summer project. Summer projects are not all bad, for they are designed
    to ensure that students continue to learn during their three month getaway
    from school. However, who should design the summer project the student or
    the teacher? Summer projects should be teacher-designed because teachers
    have more experience with projects than students, and students will lean
    toward designing a quick and easy project. Teachers have had more encounters
    with school assigned projects in their lifetime than their students. Most
    teachers have college degrees. They have done the twelve plus years of
    primary school to graduate, and then gone on to college and done two to four
    more years to get their degree. Through all that schooling many projects
    have been assigned and completed. All of this gives teachers the proper
    experience and background to come up with a well designed summer project for
    their students. Just this past summer my computer system networking teacher,
    Mr. Generic_Name, assigned us a project. It was a review project
    incorporating all of the course material from my sophomore year that he did
    not want us to forget during the summer. I remember how well rounded of a
    project it was, so much so that I had to ask him how he come up with it. Mr.
    Generic_Name told me that the project was inspired by all the projects he
    encountered during his four years at William and Mary. Due to Mr.
    Generic_Name having plenty of experience with higher education projects, it
    allowed him to design a well developed summer project for my peers and I. I
    can only imagine the toddler like projects that would have been produced if
    my peers and I were allowed to design our summer projects instead of Mr.
    Generic_Name. More than likely if a student is given the opportunity to do
    less work they are going to take that opportunity. Throughout my years of
    high school¬†I have seen this exact manner take place over and over.
    Students will take the easy way out by selecting courses that have a history
    of demanding very little from those enrolled. This same mannerism repeats
    itself once the student is enrolled in a course and it comes time to
    actually work. Just this past marking period my Math Analysis teacher, Mrs.
    Generic_Name, gave us a take home test for winter break. This test consisted
    of 47 problems. The more problems you did the higher grade you got, but
    students did not seem to take advantage of this. More than half of my class
    chose to only do 30 of the 47 problems. This was because completing 30 of
    the 47 problems earned the minimum for a passing grade, a 70 percent. My
    peers had full control of their grades and chose to only work for the
    minimum passing score so that the rest of their winter break would be free
    of math. This is what will occur if a student is allowed to design their own
    summer project. Once a student realizes that they get to design their
    project they will make it something simple, lousy, and childlike. The
    student will design something just good enough too pass, so that they can
    return to their more practical summer. Some argue that a student would be
    more inclined to do their project if they got to design it. However, this is
    not true as someone's interest in something does not determine whether they
    will do it or not, but their work ethic is the true determining factor.
    Summer projects serve a meaningful¬†purpose; to make sure kids maintain
    learning and strengthening their brains even when school is out. Something
    with a strong purpose like that should not be taken lightly and should be
    handled by someone who can produce the best project. This is why summer
    projects should be teacher-designed, so that students can take away as much
    information as possible when the project is all said and done.
  example_title: example3
metrics:
- accuracy
- f1
- roc_auc
base_model:
- intfloat/e5-small
library_name: transformers
datasets:
- liamdugan/raid
model-index:
- name: A Shared Benchmark for Robust Evaluation of Machine-Generated Text Detectors
  results:
  - task:
      type: text-classification
    dataset:
      name: RAID-test
      type: RAID-test
    metrics:
    - name: accuracy
      type: accuracy
      value: 0.939
    source:
      name: RAID Benchmark Leaderboard
      url: https://raid-bench.xyz/leaderboard
pipeline_tag: text-classification
license: mit
---

# My LoRA Fine-Tuned AI-generated Detector

This is a e5-small model fine-tuned with LoRA for sequence classification tasks. It is optimized to classify text into AI-generated or human-written with high accuracy.

- **Label_0**: Represents **human-written** content.
- **Label_1**: Represents **AI-generated** content.

## Model Details

- **Base Model**: `intfloat/e5-small`
- **Fine-Tuning Technique**: LoRA (Low-Rank Adaptation)
- **Task**: Sequence Classification
- **Use Cases**: Text classification for AI-generated detection.
- **Hyperparameters**: 
   - Learning rate: `5e-5`
   - Epochs: `3`
   - LoRA rank: `8`
   - LoRA alpha: `16`


## Training Details

- **Dataset**:
    - 10,000 twitters and 10,000 rewritten twitters with GPT-4o-mini.
    - 80,000 human-written text from [RAID-train](https://github.com/liamdugan/raid).
    - 128,000 AI-generated text from [RAID-train](https://github.com/liamdugan/raid).
- **Hardware**: Fine-tuned on a single NVIDIA A100 GPU.
- **Training Time**: Approximately 2 hours.
- **Evaluation Metrics**:
| Metric | (Raw) E5-small | Fine-tuned |
|--------|---------------:|-----------:|
|Accuracy| 65.2%          | 89.0%      |
|F1 Score| 0.653          | 0.887      |
| AUC    | 0.697          | 0.976      |

## Collaborators

- **Menglin Zhou**
- **Jiaping Liu**
- **Xiaotian Zhan**


## Citation
If you use this model, please cite the RAID dataset as follows:
```
@inproceedings{dugan-etal-2024-raid,
    title = "{RAID}: A Shared Benchmark for Robust Evaluation of Machine-Generated Text Detectors",
    author = "Dugan, Liam  and
      Hwang, Alyssa  and
      Trhl{\'\i}k, Filip  and
      Zhu, Andrew  and
      Ludan, Josh Magnus  and
      Xu, Hainiu  and
      Ippolito, Daphne  and
      Callison-Burch, Chris",
    booktitle = "Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)",
    month = aug,
    year = "2024",
    address = "Bangkok, Thailand",
    publisher = "Association for Computational Linguistics",
    url = "https://aclanthology.org/2024.acl-long.674",
    pages = "12463--12492",
}
```