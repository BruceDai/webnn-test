describe('CTS Supplement Test', function() {
  const assert = chai.assert;
  const nn = navigator.ml.getNeuralNetworkContext();

  it('check result for Add example', async function() {
    let operandIndex = 0;
    let model = await nn.createModel(options);
    let TENSOR_DIMENSIONS = [2, 2, 2, 2];
    let value0 = 0.4;
    let value1 = 0.5;
    const float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: TENSOR_DIMENSIONS};
    const tensorLength = product(float32TensorType.dimensions);

    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(float32TensorType);
    let input0Data = new Float32Array(tensorLength);
    input0Data.fill(value0);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(float32TensorType);
    let output = operandIndex++;
    model.addOperand(float32TensorType);

    model.addOperation(nn.ADD, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();

    compilation.setPreference(getPreferenceCode(options.prefer));

    await compilation.finish();

    let execution = await compilation.createExecution();

    let input1Data = new Float32Array(tensorLength);
    input1Data.fill(value1);

    execution.setInput(0, input1Data);

    let outputData = new Float32Array(tensorLength);
    execution.setOutput(0, outputData);

    await execution.startCompute();

    for (let i = 0; i < tensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], input0Data[i] + input1Data[i]));
    }
  });

  it('check result for Add broadcasting 3D-4D example/5', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([ 1,  2,  3,  4,
                                        5,  6,  7,  8,
                                        9, 10, 11, 12,
                                       13, 14, 15, 16]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.ADD, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [11, 12, 13, 14, 15, 16, 17, 18,
                        19, 20, 21, 22, 23, 24, 25, 26];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Add broadcasting 3D-4D example/6', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [4, 1, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [5, 4, 3, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [5, 4, 3, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.ADD, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([ 10,  20,  30,  40,  50,  60,  70,  80,  90, 100, 110, 120,
                                       130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240,
                                       250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350, 360,
                                       370, 380, 390, 400, 410, 420, 430, 440, 450, 460, 470, 480,
                                       490, 500, 510, 520, 530, 540, 550, 560, 570, 580, 590, 600]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [ 11,  12,  21,  22,  31,  32,  43,  44,  53,  54,  63,  64,
                         75,  76,  85,  86,  95,  96, 107, 108, 117, 118, 127, 128,
                        131, 132, 141, 142, 151, 152, 163, 164, 173, 174, 183, 184,
                        195, 196, 205, 206, 215, 216, 227, 228, 237, 238, 247, 248,
                        251, 252, 261, 262, 271, 272, 283, 284, 293, 294, 303, 304,
                        315, 316, 325, 326, 335, 336, 347, 348, 357, 358, 367, 368,
                        371, 372, 381, 382, 391, 392, 403, 404, 413, 414, 423, 424,
                        435, 436, 445, 446, 455, 456, 467, 468, 477, 478, 487, 488,
                        491, 492, 501, 502, 511, 512, 523, 524, 533, 534, 543, 544,
                        555, 556, 565, 566, 575, 576, 587, 588, 597, 598, 607, 608];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Add broadcasting 4D-4D example/5', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([ 1,  2,  3,  4,
                                        5,  6,  7,  8,
                                        9, 10, 11, 12,
                                       13, 14, 15, 16]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.ADD, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [11, 12, 13, 14, 15, 16, 17, 18,
                        19, 20, 21, 22, 23, 24, 25, 26];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Add broadcasting 4D-4D example/6', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([1,  2,  3,  4]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.ADD, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10, 20, 30, 40]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [11, 12, 13, 14, 21, 22, 23, 24,
                        31, 32, 33, 34, 41, 42, 43, 44];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Concatenation axis 0 example', async function() {
    let model = await nn.createModel(options);

    let float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand(float32TensorType);
    let inputData1 = new Float32Array(tensorLength);
    inputData1.set([201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                    209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);
    model.setOperandValue(1, inputData1);
    model.addOperand({type: nn.INT32});
    let axis = 0;
    model.setOperandValue(2, new Int32Array([axis]));

    let outputFloat32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [4, 2, 2, 2]};
    const outputTensorLength = product(outputFloat32TensorType.dimensions);

    model.addOperand(outputFloat32TensorType);
    model.addOperation(nn.CONCATENATION, [0, 1, 2], [3]);

    model.identifyInputsAndOutputs([0], [3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData0 = new Float32Array(tensorLength);
    inputData0.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                    109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0]);
    execution.setInput(0, inputData0);

    let outputData = new Float32Array(outputTensorLength);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = new Float32Array(outputTensorLength);
    expectedData.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                      109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0,
                      201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                      209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);

    for (let i = 0; i < outputTensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Concatenation axis 1 example', async function() {
    let model = await nn.createModel(options);

    let float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand(float32TensorType);
    let inputData1 = new Float32Array(tensorLength);
    inputData1.set([201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                    209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);
    model.setOperandValue(1, inputData1);
    model.addOperand({type: nn.INT32});
    let axis = 1;
    model.setOperandValue(2, new Int32Array([axis]));

    let outputFloat32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 4, 2, 2]};
    const outputTensorLength = product(outputFloat32TensorType.dimensions);

    model.addOperand(outputFloat32TensorType);
    model.addOperation(nn.CONCATENATION, [0, 1, 2], [3]);

    model.identifyInputsAndOutputs([0], [3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData0 = new Float32Array(tensorLength);
    inputData0.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                    109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0]);
    execution.setInput(0, inputData0);

    let outputData = new Float32Array(outputTensorLength);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = new Float32Array(outputTensorLength);
    expectedData.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                      201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                      109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0,
                      209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);

    for (let i = 0; i < outputTensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Concatenation axis 2 example', async function() {
    let model = await nn.createModel(options);

    let float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand(float32TensorType);
    let inputData1 = new Float32Array(tensorLength);
    inputData1.set([201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                    209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);
    model.setOperandValue(1, inputData1);
    model.addOperand({type: nn.INT32});
    let axis = 2;
    model.setOperandValue(2, new Int32Array([axis]));

    let outputFloat32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 4, 2]};
    const outputTensorLength = product(outputFloat32TensorType.dimensions);

    model.addOperand(outputFloat32TensorType);
    model.addOperation(nn.CONCATENATION, [0, 1, 2], [3]);

    model.identifyInputsAndOutputs([0], [3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData0 = new Float32Array(tensorLength);
    inputData0.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                    109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0]);
    execution.setInput(0, inputData0);

    let outputData = new Float32Array(outputTensorLength);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = new Float32Array(outputTensorLength);
    expectedData.set([101.0, 102.0, 103.0, 104.0,
                      201.0, 202.0, 203.0, 204.0,
                      105.0, 106.0, 107.0, 108.0,
                      205.0, 206.0, 207.0, 208.0,
                      109.0, 110.0, 111.0, 112.0,
                      209.0, 210.0, 211.0, 212.0,
                      113.0, 114.0, 115.0, 116.0,
                      213.0, 214.0, 215.0, 216.0]);
    for (let i = 0; i < outputTensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Concatenation axis 3 example', async function() {
    let model = await nn.createModel(options);

    let float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand(float32TensorType);
    let inputData1 = new Float32Array(tensorLength);
    inputData1.set([201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0,
                    209.0, 210.0, 211.0, 212.0, 213.0, 214.0, 215.0, 216.0]);
    model.setOperandValue(1, inputData1);
    model.addOperand({type: nn.INT32});
    let axis = 3;
    model.setOperandValue(2, new Int32Array([axis]));

    let outputFloat32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 4]};
    const outputTensorLength = product(outputFloat32TensorType.dimensions);

    model.addOperand(outputFloat32TensorType);
    model.addOperation(nn.CONCATENATION, [0, 1, 2], [3]);

    model.identifyInputsAndOutputs([0], [3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData0 = new Float32Array(tensorLength);
    inputData0.set([101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0,
                    109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0]);
    execution.setInput(0, inputData0);

    let outputData = new Float32Array(outputTensorLength);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = new Float32Array(outputTensorLength);
    expectedData.set([101.0, 102.0, 201.0, 202.0,
                      103.0, 104.0, 203.0, 204.0,
                      105.0, 106.0, 205.0, 206.0,
                      107.0, 108.0, 207.0, 208.0,
                      109.0, 110.0, 209.0, 210.0,
                      111.0, 112.0, 211.0, 212.0,
                      113.0, 114.0, 213.0, 214.0,
                      115.0, 116.0, 215.0, 216.0]);

    for (let i = 0; i < outputTensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Fully connected float 3D input example', async function() {
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let op1_value = [2, 32, 16];
    let op3_expect = [8, 68, 36];

    let type3 = {type: nn.INT32};
    let type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1]};
    let type1_length = product(type1.dimensions);
    let type2 = {type: nn.TENSOR_FLOAT32, dimensions: [1]};
    let type2_length = product(type2.dimensions);
    let type0 = {type: nn.TENSOR_FLOAT32, dimensions: [3, 1, 1]};
    let type4 = {type: nn.TENSOR_FLOAT32, dimensions: [3, 1]};
    let type4_length = product(type4.dimensions);

    let op1 = operandIndex++;
    model.addOperand(type0);
    let op2 = operandIndex++;
    model.addOperand(type1);
    let b0 = operandIndex++;
    model.addOperand(type2);
    let op3 = operandIndex++;
    model.addOperand(type4);
    let act = operandIndex++;
    model.addOperand(type3);

    model.setOperandValue(op2, new Float32Array([2]));
    model.setOperandValue(b0, new Float32Array([4]));
    model.setOperandValue(act, new Int32Array([0]));
    model.addOperation(nn.FULLY_CONNECTED, [op1, op2, b0, act], [op3]);

    model.identifyInputsAndOutputs([op1], [op3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let op1_input = new Float32Array(op1_value);
    execution.setInput(0, op1_input);

    let op3_output = new Float32Array(type4_length);
    execution.setOutput(0, op3_output);

    await execution.startCompute();

    for (let i = 0; i < type4_length; ++i) {
      assert.isTrue(almostEqualCTS(op3_output[i], op3_expect[i]));
    }
  });

  it('check result for Fully connected float 3D input example/2', async function() {
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let op1_value = [1, 10, 100];
    let op3_expect = [127];

    let type3 = {type: nn.INT32};
    let type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 3]};
    let type1_length = product(type1.dimensions);
    let type2 = {type: nn.TENSOR_FLOAT32, dimensions: [1]};
    let type2_length = product(type2.dimensions);
    let type0 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 3]};
    let type4 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1]};
    let type4_length = product(type4.dimensions);

    let op1 = operandIndex++;
    model.addOperand(type0);
    let op2 = operandIndex++;
    model.addOperand(type1);
    let b0 = operandIndex++;
    model.addOperand(type2);
    let op3 = operandIndex++;
    model.addOperand(type4);
    let act = operandIndex++;
    model.addOperand(type3);

    model.setOperandValue(op2, new Float32Array([3, 2, 1]));
    model.setOperandValue(b0, new Float32Array([4]));
    model.setOperandValue(act, new Int32Array([0]));
    model.addOperation(nn.FULLY_CONNECTED, [op1, op2, b0, act], [op3]);

    model.identifyInputsAndOutputs([op1], [op3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let op1_input = new Float32Array(op1_value);
    execution.setInput(0, op1_input);

    let op3_output = new Float32Array(type4_length);
    execution.setOutput(0, op3_output);

    await execution.startCompute();

    for (let i = 0; i < type4_length; ++i) {
      assert.isTrue(almostEqualCTS(op3_output[i], op3_expect[i]));
    }
  });

  it('check result for Fully connected float 4D input example', async function() {
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let op1_value = [2, 32, 16];
    let op3_expect = [8, 68, 36];

    let type3 = {type: nn.INT32};
    let type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1]};
    let type1_length = product(type1.dimensions);
    let type2 = {type: nn.TENSOR_FLOAT32, dimensions: [1]};
    let type2_length = product(type2.dimensions);
    let type0 = {type: nn.TENSOR_FLOAT32, dimensions: [3, 1, 1, 1]};
    let type4 = {type: nn.TENSOR_FLOAT32, dimensions: [3, 1]};
    let type4_length = product(type4.dimensions);

    let op1 = operandIndex++;
    model.addOperand(type0);
    let op2 = operandIndex++;
    model.addOperand(type1);
    let b0 = operandIndex++;
    model.addOperand(type2);
    let op3 = operandIndex++;
    model.addOperand(type4);
    let act = operandIndex++;
    model.addOperand(type3);

    model.setOperandValue(op2, new Float32Array([2]));
    model.setOperandValue(b0, new Float32Array([4]));
    model.setOperandValue(act, new Int32Array([0]));
    model.addOperation(nn.FULLY_CONNECTED, [op1, op2, b0, act], [op3]);

    model.identifyInputsAndOutputs([op1], [op3]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let op1_input = new Float32Array(op1_value);
    execution.setInput(0, op1_input);

    let op3_output = new Float32Array(type4_length);
    execution.setOutput(0, op3_output);

    await execution.startCompute();

    for (let i = 0; i < type4_length; ++i) {
      assert.isTrue(almostEqualCTS(op3_output[i], op3_expect[i]));
    }
  });

  it('check result for Mul example', async function() {
    let operandIndex = 0;
    let model = await nn.createModel(options);
    let TENSOR_DIMENSIONS = [2, 2, 2, 2];
    let value0 = 0.4;
    let value1 = 0.5;

    const float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: TENSOR_DIMENSIONS};
    const tensorLength = product(float32TensorType.dimensions);

    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(float32TensorType);
    let input0Data = new Float32Array(tensorLength);
    input0Data.fill(value0);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(float32TensorType);
    let output = operandIndex++;
    model.addOperand(float32TensorType);

    model.addOperation(nn.MUL, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();

    compilation.setPreference(getPreferenceCode(options.prefer));

    await compilation.finish();

    let execution = await compilation.createExecution();

    let input1Data = new Float32Array(tensorLength);
    input1Data.fill(value1);

    execution.setInput(0, input1Data);

    let outputData = new Float32Array(tensorLength);
    execution.setOutput(0, outputData);

    await execution.startCompute();

    for (let i = 0; i < tensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], input0Data[i] * input1Data[i]));
    }
  });

  it('check result for Mul broadcasting 3D-4D example/5', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([ 1,  2,  3,  4,
                                        5,  6,  7,  8,
                                        9, 10, 11, 12,
                                       13, 14, 15, 16]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.MUL, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [ 10,  20,  30,  40,  50,  60,  70,  80,
                         90, 100, 110, 120, 130, 140, 150, 160];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Mul broadcasting 3D-4D example/6', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [4, 1, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [5, 4, 3, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [5, 4, 3, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.MUL, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([ 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12,
                                       13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
                                       25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
                                       37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
                                       49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);

    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [ 1,  1,  2,  2,  3,  3,  4,  4,  5,  5,  6,  6,
                         7,  7,  8,  8,  9,  9, 10, 10, 11, 11, 12, 12,
                        13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18,
                        19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24,
                        25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 30, 30,
                        31, 31, 32, 32, 33, 33, 34, 34, 35, 35, 36, 36,
                        37, 37, 38, 38, 39, 39, 40, 40, 41, 41, 42, 42,
                        43, 43, 44, 44, 45, 45, 46, 46, 47, 47, 48, 48,
                        49, 49, 50, 50, 51, 51, 52, 52, 53, 53, 54, 54,
                        55, 55, 56, 56, 57, 57, 58, 58, 59, 59, 60, 60];


    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Mul broadcasting 4D-4D example/5', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([ 1,  2,  3,  4,
                                        5,  6,  7,  8,
                                        9, 10, 11, 12,
                                       13, 14, 15, 16]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.MUL, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [ 10,  20,  30,  40,  50,  60,  70,  80,
                         90, 100, 110, 120, 130, 140, 150, 160];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Mul broadcasting 4D-4D example/6', async function() {
    let model = await nn.createModel(options);
    const type0 = {type: nn.TENSOR_FLOAT32, dimensions: [1, 1, 2, 2]};
    const type1 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 1, 1]};
    const type2 = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2, 2, 2]};
    const length = product(type2.dimensions);

    let operandIndex = 0;
    let fusedActivationFuncNone = operandIndex++;
    model.addOperand({type: nn.INT32});
    model.setOperandValue(fusedActivationFuncNone, new Int32Array([nn.FUSED_NONE]));

    let input0 = operandIndex++;
    model.addOperand(type0);
    let input0Data = new Float32Array([1,  2,  3,  4]);

    model.setOperandValue(input0, input0Data);

    let input1 = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.addOperation(nn.MUL, [input0, input1, fusedActivationFuncNone], [output]);
    model.identifyInputsAndOutputs([input1], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();
    let input1Data = new Float32Array([10, 20, 30, 40]);
    execution.setInput(0, input1Data);
    let outputData = new Float32Array(length);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    let expectedData = [ 10,  20,  30,  40,  20,  40,  60,  80,
                         30,  60,  90, 120,  40,  80, 120, 160];
    for (let i = 0; i < length; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });

  it('check result for Reshape example', async function() {
    let model = await nn.createModel(options);

    const float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions:[1, 4]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand({type: nn.TENSOR_INT32, dimensions: [2]});
    model.setOperandValue(1, new Int32Array([2, 2]));
    model.addOperand({type: nn.TENSOR_FLOAT32, dimensions: [2, 2]});
    model.addOperation(nn.RESHAPE, [0, 1], [2]);

    model.identifyInputsAndOutputs([0], [2]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData = new Float32Array(tensorLength);
    inputData.set([1.0, 2.0, 3.0, 4.0]);
    execution.setInput(0, inputData);

    let outputData = new Float32Array(tensorLength);
    execution.setOutput(0, outputData);
    await execution.startCompute();

    for (let i = 0; i < tensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], inputData[i]));
    }
  });

  it('check result for Softmax example', async function() {
    let model = await nn.createModel(options);
    const float32TensorType = {type: nn.TENSOR_FLOAT32, dimensions: [2, 2]};
    const tensorLength = product(float32TensorType.dimensions);

    model.addOperand(float32TensorType);
    model.addOperand({type: nn.FLOAT32});
    model.setOperandValue(1, new Float32Array([1.0]));
    model.addOperand(float32TensorType);
    model.addOperation(nn.SOFTMAX, [0, 1], [2]);

    model.identifyInputsAndOutputs([0], [2]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let inputData0 = new Float32Array(tensorLength);
    inputData0.set([1.0, 1.0, 1.0, 1.0]);
    execution.setInput(0, inputData0);

    let outputData = new Float32Array(tensorLength);
    execution.setOutput(0, outputData);

    await execution.startCompute();
    let expectedData = new Float32Array(tensorLength);
    expectedData.set([0.5, 0.5, 0.5, 0.5]);

    for (let i = 0; i < tensorLength; ++i) {
      assert.isTrue(almostEqualCTS(outputData[i], expectedData[i]));
    }
  });
});
