"""Synthetic OOXML packages with explicit facts; no production material."""
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

DOCUMENTS = [
    ("20261021-array-architecture.pptx", [
        "Hybrid beamforming architecture\nAn array with 64 antennas uses only 4 RF chains. The analog phase-shifter network distributes each RF signal across antennas. A digital baseband precoder combines 4 data streams before the RF chains.",
        "Alternating optimization\nFix the analog phase-shifter matrix and update digital baseband weights; then hold the digital precoder fixed and project the analog weights onto unit modulus. Repeat these two steps. Phase shifters change phase, not amplitude.",
        "Hardware limitation\nConstant-modulus analog weights have unit magnitude. A fully digital reference needs one RF chain per antenna. Hybrid precoding reduces RF hardware at the cost of a constrained analog stage.",
    ]),
    ("20261021-uplink-power.pptx", [
        "上行开环功控\n目标接收功率由 P0 和路径损耗补偿 alpha 决定。功率受终端最大功率上限约束；小区边缘不能无限加大发射功率。",
        "UL closed-loop power control\nTPC commands adjust uplink transmit power around the open-loop operating point. Closed-loop power control corrects residual mismatch; it does not remove the UE maximum power constraint.",
        "功控取舍\n提高小区边缘终端的功率可能改善本小区接收质量，也可能增加邻区干扰。应同时观察边缘吞吐与邻区干扰，而不是只看接收功率。",
    ]),
    ("20261021-channel-notes.pptx", [
        "SRS 信道估计\n通过上行导频观测复数信道，接收权重需要保留相位信息。SRS 端口配置与终端天线数量不是同一概念。",
        "Temporal phase averaging\nTwo valid complex channel samples with opposite phase can cancel under direct averaging. Averaging instantaneous received power is different from taking the power of the averaged complex channel.",
        "非理想 CSI\n信道估计与数据调度之间存在时延。高速运动会使旧 CSI 的相关性下降，需要区分估计噪声与信道老化。",
    ]),
    ("20261021-scheduling-notes.pptx", [
        "比例公平调度\n比例公平以瞬时速率除以历史平均吞吐来度量用户。最大吞吐调度只看当前可达速率，可能长期冷落边缘用户。",
        "业务时延\n队首时延描述最早待发数据的等待时间。吞吐相同的两个方案，队首时延分布仍可能不同。",
        "HARQ 重传\n重传占用调度资源；统计净吞吐时只计成功交付的业务比特。链路 BLER 与业务吞吐不能直接等同。",
    ]),
    ("20261021-unsuitable-designs.pptx", [
        "Fully digital beamforming\nThis design has 64 RF chains for 64 antennas. Every antenna uses an independent digital weight with arbitrary amplitude and phase. It does not model an analog phase-shifter constraint.",
        "Simulation disclaimer\nThe figures are illustrative. These slides contain no measured throughput comparison and cannot establish a measured percentage gain.",
    ]),
]


def make_pptx(file, pages):
    # Non-monotonic part numbers ensure extraction follows the presentation order.
    numbers = list(range(len(pages), 0, -1))
    xmlns_p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
    xmlns_a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    xmlns_r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    with zipfile.ZipFile(file, 'w', zipfile.ZIP_DEFLATED) as z:
        overrides = ''.join(f'<Override PartName="/ppt/slides/slide{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for n in numbers)
        z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' + overrides + '</Types>')
        z.writestr('_rels/.rels', f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{xmlns_r}/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
        z.writestr('ppt/presentation.xml', f'<p:presentation xmlns:p="{xmlns_p}" xmlns:r="{xmlns_r}"><p:sldIdLst>' + ''.join(f'<p:sldId id="{255+i}" r:id="rId{i}"/>' for i in range(1, len(pages)+1)) + '</p:sldIdLst></p:presentation>')
        z.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="{xmlns_r}/slide" Target="slides/slide{n}.xml"/>' for i, n in enumerate(numbers, 1)) + '</Relationships>')
        for n, text in zip(numbers, pages):
            paragraphs = ''.join('<a:p><a:r><a:t>' + escape(line) + '</a:t></a:r></a:p>' for line in text.split('\n'))
            z.writestr(f'ppt/slides/slide{n}.xml', f'<p:sld xmlns:p="{xmlns_p}" xmlns:a="{xmlns_a}"><p:cSld><p:spTree><p:sp><p:txBody>{paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>')


if __name__ == '__main__':
    root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
    for name, pages in DOCUMENTS:
        make_pptx(root / name, pages)
    (root / '20261021-legacy.ppt').write_bytes(b'legacy format deliberately skipped')
    (root / '20261021-broken.pptx').write_bytes(b'invalid package: independent file error')
    print(json.dumps({'files': len(DOCUMENTS), 'pages': sum(len(p) for _, p in DOCUMENTS)}, ensure_ascii=False))
